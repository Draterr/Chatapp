import asyncio
from loguru import logger
from datetime import datetime,timezone
from typing import Annotated
from fastapi import APIRouter, WebSocket, WebSocketDisconnect,Depends,HTTPException
from fastapi.encoders import jsonable_encoder
import json
from typing import List,Literal
from pydantic import BaseModel
from db import connection,iso_utc
from dependencies import sort_by_time
from routers.users import verify_jwt
from pubsub import *


wsroute = APIRouter()

class MessageFrame(BaseModel):
    type: Literal['message']
    message_id: str
    sender_id: int
    sender_name: str
    message: str
    time_sent:str
    chat_id:str

class AcknowledgeResponse(BaseModel):
    type:str
    content:dict
    timestamp:str


class ErrorResponse(BaseModel):
    type: str
    code:str
    detail: str 

CLIENT_CONTROL_ACTIONS = {"typing"}

class WebsocketManager:
    def __init__(self):
        self.active_connections = {}
        self.chats = {}
        self.pubsub_instance = Pubsub()

    async def connect(self,client_id:int,websocket:WebSocket,chat_ids:List[str]):
        if client_id in self.active_connections:
            return None
        for chat_id in chat_ids:
            # get_chats() returns a flat list of chat_id strings; indexing [0] here used
            # to unwrap aiomysql's 1-tuples and silently registered the first character.
            if self.chats.get(chat_id) is None:
                self.chats[chat_id] = [(client_id,websocket)]
            else:
                self.chats[chat_id].append((client_id,websocket))
            # NOTE: no pubsub.subscribe() here — the reader psubscribes("*") once at
            # startup and owns the connection exclusively. Touching pubsub from this
            # request task races the reader's read ("readuntil() already waiting").
        logger.info(f"{client_id} joined chat {chat_ids}")  
        self.active_connections.update({client_id:websocket})
        return True

    async def pubsub_reader(self):
        pubsub = self.pubsub_instance.pubsub
        try:
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message is None:
                    continue
                try:
                    await self._handle_pubsub_message(message)
                except Exception:
                    # never let one bad frame kill fan-out for the whole process
                    logger.exception(f"pubsub_reader: failed to handle {message}")
        except asyncio.CancelledError:
            return                                    # clean shutdown: stop reading before the conn closes

    async def _handle_pubsub_message(self,message:dict):
        chat_id = message["channel"]
        content = message["data"]                     # already a JSON string
        if chat_id == "control":
            await self._handle_control(json.loads(content))
            return
        subscribers = self.chats.get(chat_id)
        if not subscribers:
            return                                    # no local sockets for this chat -> ignore
        logger.info("got message "+str(message))
        message_id = json.loads(content)["message_id"]
        for receiver_id,websocket in list(subscribers):
            try:
                await websocket.send_text(content)
            except Exception:
                continue                              # dead socket -> leave NOT-DELIVERED, replays on reconnect
            await connection.set_delivery_status([message_id],receiver_id)

    async def _handle_control(self,content:dict):
        control_frame_list = ["create_channel","delete_channel","add_member","remove_member","rename_channel","edit_message",*CLIENT_CONTROL_ACTIONS]
        if content["type"] not in control_frame_list:
            logger.warning(f"unknown control frame: {content}")
            return
        chat_id = content["chat_id"]
        if content["type"] == "create_channel":
            notify = json.dumps({"type":"chat_created","chat_id":chat_id})
            for user_id in content["user_ids"]:
                websocket = self.active_connections.get(user_id)
                if websocket is None:
                    continue                              # not connected to this worker
                members = self.chats.setdefault(chat_id,[])
                entry = (user_id,websocket)
                if entry not in members:                  # connect() may already have registered it
                    members.append(entry)
                try:
                    await websocket.send_text(notify)     # tell the client to refetch /chats
                except Exception:
                    continue

        elif content["type"] == "delete_channel":
            notify = json.dumps({"type":"chat_deleted","chat_id":chat_id})
            chat = self.chats.pop(chat_id,None) or []   # None when no socket here is registered
            for user_id,websocket in chat:
                try:
                    await websocket.send_text(notify)     # tell the client to refetch /chats
                except Exception:
                    continue
        
        elif content["type"] == "add_member":
            notify = json.dumps({"type":"member_added","chat_id":chat_id,"user_id":content["user_id"]})
            user_id = content["user_id"]
            websocket = self.active_connections.get(user_id)
            if websocket is None:
                return                                  # not connected to this worker
            members = self.chats.setdefault(chat_id,[])
            entry = (user_id,websocket)
            if entry not in members:                      # `if members:` skipped the first one
                members.append(entry)
            try:
                await websocket.send_text(notify)         # tell the client to refetch /chats
            except Exception:
                return

        elif content["type"] == "remove_member":
            notify = json.dumps({"type":"member_removed","chat_id":chat_id,"user_id":content["user_id"]})
            user_id = content["user_id"]
            websocket = self.active_connections.get(user_id)
            if websocket is None:
                return                                  # not connected to this worker
            # Deregister if we hold it, but notify either way: .remove() on a missing
            # entry raises ValueError, which pubsub_reader swallows, losing the frame.
            members = self.chats.get(chat_id)
            entry = (user_id,websocket)
            if members and entry in members:
                members.remove(entry)
            try:
                await websocket.send_text(notify)         # tell the client to refetch /chats
            except Exception:
                return
        
        elif content["type"] == "rename_channel":
            notify = json.dumps({"type":"chat_renamed","chat_id":chat_id,"new_name":content["new_name"]})
            members = self.chats.get(chat_id)
            if not members:
                return                                  # no local sockets for this chat -> ignore
            for user_id,websocket in list(members):
                try:
                    await websocket.send_text(notify)     # tell the client to refetch /chats
                except Exception:
                    continue

        elif content["type"] == "typing":
            user_id = content["user_id"]
            notify = json.dumps({"type":"user_typing","chat_id":chat_id,"user_id":user_id})
            members = self.chats.get(chat_id,[])
            if not members:
                return
            for cur_id,websocket in members:
                if cur_id == user_id:
                    continue
                try:
                    await websocket.send_text(notify)
                except Exception:
                    continue


    async def send_message(self,message:str,chat_id:str):
        await self.pubsub_instance.publish_message(chat_id,message)
    
    
    async def notify_status(self,error_message:ErrorResponse,sender_id:int):
        sender_websocket = self.active_connections.get(sender_id)
        if sender_websocket:
            await sender_websocket.send_json(error_message,mode="text")

    async def disconnect(self,client_id:int,websocket):
        self.active_connections.pop(client_id,None)
        entry = (client_id,websocket)
        for chat_id in list(self.chats):          
            members = self.chats[chat_id]
            if entry not in members:
                continue
            members.remove(entry)
            logger.info(f"{client_id} removed from {chat_id}")
            if not members:                       
                del self.chats[chat_id]
                logger.info(f"{chat_id} empty; dropped")

    def __str__(self):
        return str(self.active_connections)

manager = WebsocketManager()
@wsroute.on_event("startup")
async def start_pubsub_reader():
    # Subscribe once to ALL channels (chat_ids) with a pattern; the reader then owns the
    # pubsub connection alone. connect()/disconnect() only mutate self.chats, never pubsub.
    await manager.pubsub_instance.psubscribe("*")
    manager.reader_task = asyncio.create_task(manager.pubsub_reader())


@wsroute.on_event("shutdown")
async def stop_pubsub_reader():
    # Orderly shutdown so the reader isn't parked in get_message()'s readuntil() when the
    # redis connection is torn down. Cancelling a blocked redis read raises a RuntimeError
    # (not CancelledError) from redis-py, so suppress whatever `await task` raises — awaiting
    # it also "retrieves" the exception, silencing the "Task exception was never retrieved" log.
    task = getattr(manager, "reader_task", None)
    if task:
        task.cancel()
        try:
            await task
        except BaseException:
            pass
    try:
        await manager.pubsub_instance.pubsub.aclose()
        await manager.pubsub_instance.r.aclose()
    except Exception:
        pass
        


async def user_send_message(sender_name:str,sender_id:int,chat_id:str,message:str):
    time = datetime.now(timezone.utc)
    time_sent = time.strftime("%Y-%m-%d %H:%M:%S.%f")           # MySQL-friendly for storage
    try:
        message_id = await connection.insert_message(sender_id,time_sent,chat_id,message)
    except PermissionError:
        logger.exception("User not part of chat")          # full traceback for the real cause
        response = jsonable_encoder(ErrorResponse(type="error",code="NOT_A_MEMBER",detail="User not part of Chat"))
        await manager.notify_status(response,sender_id)    # generic detail to the client
        return
    except Exception:
        logger.exception("insert_message failed")          # full traceback for the real cause
        response = jsonable_encoder(ErrorResponse(type="error",code="DB_INSERT_ERROR",detail="could not save message"))
        await manager.notify_status(response,sender_id)    # generic detail to the client
        return
    response = jsonable_encoder(AcknowledgeResponse(type="ack",content={"message":message,"chat_id":chat_id},timestamp=time.isoformat()))
    await manager.notify_status(response,sender_id)
    response = jsonable_encoder(MessageFrame(type="message",message_id=str(message_id),sender_id=sender_id,sender_name=sender_name,message=message,time_sent=time.isoformat(),chat_id=chat_id))
    await manager.send_message(json.dumps(response),chat_id)


async def deliver_pending_messages(messages:tuple,receiver_id:int):
    if not messages:
        return
    objs = {}
    #unpack the tuples returned by the database and put the individual messages in each chat_id 
    for chat_id,time_sent,content,sender,message_id,sender_name in messages:
        if chat_id in objs:
            continue
        objs[chat_id] = []
    #populate each MessageFrame with the message information
    message_ids = []
    for message in messages:
        chat_id = message[0]
        time_sent = message[1]
        content = message[2]
        sender = message[3]
        message_id = message[4]
        sender_name = message[5]
        tmp = MessageFrame(type="message",message_id=message_id,sender_id=sender,message=content,time_sent=iso_utc(time_sent),chat_id=chat_id,sender_name=sender_name)
        objs[chat_id].append(tmp)
        message_ids.append(message_id)
    #Sort the messages by the time sent
    for chat_id,value in objs.items():
        objs[chat_id] = sort_by_time(value)
    logger.info(f"{sender} sent {receiver_id}: {content}")
    logger.debug(objs)
    await manager.active_connections.get(receiver_id).send_json(jsonable_encoder(objs),mode="text")
    await connection.set_delivery_status(message_ids,receiver_id)


async def _reject(websocket:WebSocket,code:str,detail:str):
    """Tell the client a frame was refused, tolerating a socket that just died."""
    try:
        await websocket.send_json(jsonable_encoder(ErrorResponse(type="error",code=code,detail=detail)))
    except Exception:
        pass                                       # already gone; receive_json will raise next

async def send_message(username:str,client_id:int,websocket:WebSocket):
    while True:
        # receive_json() raises on a disconnect or on a non-JSON text frame; a disconnect
        # has to reach the endpoint so its `finally` can deregister the socket, while bad
        # JSON is the client's problem and must not end the loop.
        try:
            data = await websocket.receive_json()
        except WebSocketDisconnect:
            raise
        except json.JSONDecodeError:
            await _reject(websocket,"400","Malformed frame: expected JSON")
            continue
        logger.info(f"{client_id} said {data}")
        # Everything from here on is driven by client input, so one malformed frame may
        # only skip itself. Letting it out of the loop leaves the socket open but unread:
        # the client keeps seeing a live connection while nothing it sends is handled.
        try:
            if not isinstance(data,dict):
                await _reject(websocket,"400","Malformed frame: expected an object")
                continue
            type = data.get("type")
            if type == "message":
                message = data.get("message")
                chat_id = data.get("chat_id")
                if not isinstance(message,str) or not isinstance(chat_id,str):
                    await _reject(websocket,"400","A message frame needs string `message` and `chat_id`")
                    continue
                await user_send_message(username,client_id,chat_id,message)
            elif type == "control":
                action = data.get("action")
                if action not in CLIENT_CONTROL_ACTIONS:
                    await _reject(websocket,"404","anything but typing frame must be done with api")
                    continue
                if (client_id, websocket) not in manager.chats.get(data.get("chat_id"),[]):
                    await _reject(websocket,"400","Something Went Wrong")
                    continue
                msg = {"type":action,"chat_id":data["chat_id"],"user_id":client_id}
                await manager.pubsub_instance.publish_message("control",json.dumps(msg))
            else:
                await _reject(websocket,"415","Unsupported Message Type")
        except WebSocketDisconnect:
            raise                                  # the socket is gone; let the endpoint clean up
        except Exception:
            logger.exception(f"dropping bad frame from {client_id}: {data}")
            await _reject(websocket,"500","Could not handle that frame")

@wsroute.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket,session: Annotated[dict|None, Depends(verify_jwt)]):
    if not session:
        raise HTTPException(status_code=401,detail="Unauthorized")

    await websocket.accept()
    client_id = session["user_id"]
    username = session["user"]
    logger.info(f"{username} connected")
    try:
        chat_ids = await connection.get_chats(client_id)
        connect_status = await manager.connect(client_id,websocket,chat_ids)
    except Exception:
        logger.exception("connect failed")         # DB/connect failure before registration
        return                                     # nothing registered yet -> no cleanup needed
    if not connect_status:
        return                                     # duplicate connection — this socket was never
                                                   # registered, so don't run cleanup for it
    try:
        pending_messages = await connection.check_pending_messages(client_id)
        if pending_messages:
            await deliver_pending_messages(pending_messages,client_id)
        await send_message(username,client_id,websocket)
    except WebSocketDisconnect:
        logger.info(f"{username} disconnected")
    except Exception:
        logger.exception("websocket loop error")
    finally:
        await manager.disconnect(client_id,websocket)

