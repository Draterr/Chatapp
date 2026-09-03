import asyncio
from loguru import logger
from datetime import datetime,timezone
from typing import Annotated
from fastapi import APIRouter, WebSocket, WebSocketDisconnect,Depends,HTTPException
from fastapi.encoders import jsonable_encoder
import json
from typing import List,Literal
from pydantic import BaseModel
from db import connection
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

class WebsocketManager:
    def __init__(self):
        self.active_connections = {}
        self.chats = {}
        self.pubsub_instance = Pubsub()

    async def connect(self,client_id:int,websocket:WebSocket,chat_ids:List[str]):
        if client_id in self.active_connections:
            return None
        for i in chat_ids:
            chat_id = i[0]
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
                chat_id = message["channel"]
                subscribers = self.chats.get(chat_id)
                if not subscribers:
                    continue                          # no local sockets for this chat -> ignore
                logger.info("got message "+str(message))
                content = message["data"]             # already a JSON string
                message_id = json.loads(content)["message_id"]
                for receiver_id,websocket in list(subscribers):
                    try:
                        await websocket.send_text(content)
                    except Exception:
                        continue                      # dead socket -> leave NOT-DELIVERED, replays on reconnect
                    await connection.set_delivery_status([message_id],receiver_id)
        except asyncio.CancelledError:
            return                                    # clean shutdown: stop reading before the conn closes


    async def send_message(self,message:str,chat_id:str):
        await self.pubsub_instance.publish_message(chat_id,message)
    
    
    async def notify_status(self,error_message:ErrorResponse,sender_id:int):
        sender_websocket = self.active_connections.get(sender_id)
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
    time = datetime.now(timezone.utc).replace(tzinfo=None)   # naive UTC
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
        tmp = MessageFrame(type="message",message_id=message_id,sender_id=sender,message=content,time_sent=time_sent.isoformat(),chat_id=chat_id,sender_name=sender_name)
        objs[chat_id].append(tmp)
        message_ids.append(message_id)
    #Sort the messages by the time sent
    for chat_id,value in objs.items():
        objs[chat_id] = sort_by_time(value)
    logger.info(f"{sender} sent {receiver_id}: {content}")
    logger.debug(objs)
    await manager.active_connections.get(receiver_id).send_json(jsonable_encoder(objs),mode="text")
    await connection.set_delivery_status(message_ids,receiver_id)


async def send_message(username:str,client_id:str,websocket:WebSocket):
    while True:
        data = await websocket.receive_json()
        logger.info(f"{client_id} said {data}")
        type = data["type"]
        message = data["message"]
        chat_id = data["chat_id"]
        if type == "message":
            await user_send_message(username,client_id,chat_id,message)
        else:
            await websocket.send_json(jsonable_encoder(ErrorResponse(type="error",code="unsupported_message_type",detail="the type is unsupported")))

@wsroute.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket,session: Annotated[dict|None, Depends(verify_jwt)]):
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")

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

