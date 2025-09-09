from sys import stdout
from loguru import logger
import asyncio
from datetime import datetime,timezone
from typing import Annotated
from fastapi import APIRouter, WebSocket, WebSocketDisconnect,Depends,HTTPException
from fastapi.encoders import jsonable_encoder
import json
from typing import List
from pydantic import BaseModel
from db import connection
from dependencies import sort_by_time
from routers.users import verify_jwt
from pubsub import *


logger.add(stdout,format="{time} {level} {message}",level="INFO")
wsroute = APIRouter()

class SuccessMessage(BaseModel):
    message_id: str
    sender_id: int 
    message: str
    time_sent:str

class SuccessResponse(BaseModel):
    messages: List[SuccessMessage]
    timestamp: str

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
            await self.pubsub_instance.subscribe(chat_id)
            logger.info(f"{client_id} sub to {chat_id}")
        logger.info(f"{client_id} joined chat {chat_ids}")  
        self.active_connections.update({client_id:websocket})
        return True

    async def pubsub_reader(self):
            while True:
                message = await self.pubsub_instance.pubsub.get_message(ignore_subscribe_messages=True)
                if message is not None:
                    logger.info("got message "+str(message))
                    chat_id = message["channel"]
                    content = message["data"]
                    logger.debug(self.chats)
                    for _,websocket in self.chats[chat_id]:
                        await websocket.send_json(content,mode="text")

    async def send_message(self,message:str,chat_id:str):
        await self.pubsub_instance.publish_message(chat_id,message)
    
    
    async def notify_status(self,error_message:ErrorResponse,sender_id:int):
        sender_websocket = self.active_connections.get(sender_id)
        await sender_websocket.send_json(error_message,mode="text")

    async def broadcast(self,message:str):
        for i in self.active_connections:
            await i.send_json(message) 

    async def disconnect(self,client_id:int,websocket):
        del self.active_connections[client_id]
        for i in self.chats.values():
            i.remove((client_id,websocket))
            logger.info(f"{i} has been removed from active websockets")

    def __str__(self):
        return str(self.active_connections)

class MessageManager:
    def __init__(self,message):
        self.messagecontext = json.loads(message)
    def get_client_id(self):
        return self.messagecontext["client_id"]
    def get_message(self):
        return self.messagecontext["message"]
    def get_chat_id(self):
        return self.messagecontext["chat_id"]
    def __str__(self):
        return json.dumps(self.messagecontext)

manager = WebsocketManager()
@wsroute.on_event("startup")
async def start_pubsub_reader():
    await manager.pubsub_instance.subscribe("init")
    message = await manager.pubsub_instance.pubsub.get_message()
    if message is not None and message["type"] == "subscribe":
        asyncio.create_task(manager.pubsub_reader())
        

async def user_send_message(sender_id:int,chat_id:str,message:str):
    time = datetime.now(timezone.utc)
    time_sent = time.strftime("%Y-%m-%d %H:%M:%S.%f")
    insert_status = await connection.insert_message(sender_id,time_sent,chat_id,message)
    if insert_status != True:
        response = jsonable_encoder(ErrorResponse(type="error",code="DB INSERT ERROR",detail=str(insert_status)))
        await manager.notify_status(response,sender_id)
    else:
        time_stamp = time.strftime("%H:%M:%S")
        response = jsonable_encoder(AcknowledgeResponse(type="ack",content={"message":message,"chat_id":chat_id},timestamp=time_stamp))
        await manager.notify_status(response,sender_id)
        await manager.send_message(message,chat_id)


async def deliver_pending_messages(messages:tuple,receiver_id:int):
    if not messages:
        return
    time_stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    objs = {}
    #unpack the tuples returned by the database and put the individual messages in each chat_id 
    for chat_id,time_sent,content,sender,message_id in messages:
        if chat_id in objs:
            continue
        objs[chat_id] = SuccessResponse(messages=[],timestamp=time_stamp)
    #populate each SuccessMessage with the message information
    message_ids = []
    for message in messages:
        chat_id = message[0]
        time_sent = message[1]
        content = message[2]
        sender = message[3]
        message_id = message[4]
        tmp = SuccessMessage(message_id=message_id,sender_id=sender,message=content,time_sent=time_sent.strftime("%Y-%m-%d %H:%M:%S.%f"))
        objs[chat_id].messages.append(tmp)
        message_ids.append(message_id)
    #Sort the messages by the time sent
    for chat_id,value in objs.items():
        objs[chat_id].messages = sort_by_time(value.messages)
    logger.info(f"{sender} sent {receiver_id}: {content}")
    logger.debug(objs)
    await manager.active_connections.get(receiver_id).send_json(jsonable_encoder(objs),mode="text")
    await connection.set_delivery_status(message_ids)


async def send_message(client_id:str,websocket:WebSocket):
    while True:
        data = await websocket.receive_json()
        logger.info(f"{client_id} said {data}")
        client_id = data["client_id"]
        message = data["message"]
        chat_id = data["chat_id"]
        await user_send_message(client_id,chat_id,message)

@wsroute.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket,session: Annotated[dict|None, Depends(verify_jwt)]):
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")

    await websocket.accept()
    client_id = session["user_id"]
    username = session["user"]
    logger.info(f"{username} connected")
    chat_ids = await connection.get_chats(client_id)
    connect_status = await manager.connect(client_id,websocket,chat_ids)
    if not connect_status:
        return
    else:
        pending_messages = await connection.check_pending_messages(client_id)
        if pending_messages:
            await deliver_pending_messages(pending_messages,client_id)
    try:
        await send_message(client_id,websocket)
    except WebSocketDisconnect:
        await manager.disconnect(client_id,websocket)
        logger.error(f"{username} disconnected")
    except Exception as e:
        logger.error(e)

