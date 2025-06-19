from datetime import datetime,timezone
from typing import Annotated
from fastapi import APIRouter, WebSocket, WebSocketDisconnect,Depends,HTTPException
from fastapi.encoders import jsonable_encoder
import json
from typing import List
from pydantic import BaseModel
from app.db import connection
from app.dependencies import sort_by_time
from app.routers.users import verify_jwt

wsroute = APIRouter()

class SuccessMessage(BaseModel):
    message_id: str
    sender_id: int 
    message: str
    time_sent:str

class SuccessResponse(BaseModel):
    chat_id: str
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

class connection_manager:
    def __init__(self):
        self.active_connections = {}

    async def connect(self,client_id:int,websocket:WebSocket):
        if client_id in self.active_connections:
            return None
        self.active_connections.update({client_id:websocket})
        print(self.active_connections)
        return True

    async def send_message(self,message:dict | ErrorResponse,receiver_id:int):
        websocket = self.active_connections[receiver_id]
        await websocket.send_json(message,mode="text")

    async def broadcast(self,message:str):
        for i in self.active_connections:
            await i.send_text(message) 

    async def disconnect(self,client_id:int):
        del self.active_connections[client_id]

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

manager = connection_manager()

async def user_send_message(sender_id:int,chat_id:str,message:str):
    time = datetime.now(timezone.utc)
    time_sent = time.strftime("%Y-%m-%d %H:%M:%S.%f")
    insert_status = await connection.insert_message(sender_id,time_sent,chat_id,message)
    if insert_status != True:
        response = jsonable_encoder(ErrorResponse(type="error",code="DB INSERT ERROR",detail=str(insert_status)))
        await manager.send_message(response,sender_id)
    else:
        time_stamp = time.strftime("%H:%M:%S")
        response = jsonable_encoder(AcknowledgeResponse(type="ack",content={"message":message,"chat_id":chat_id},timestamp=time_stamp))
        await manager.send_message(response,sender_id)


async def deliver_pending_messages(messages:tuple,receiver_id:int):
    if not messages:
        return
    time_stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    objs = {}
    #unpack the tuples returned by the database and put the individual messages in each chat_id 
    for chat_id,time_sent,content,sender,message_id in messages:
        if chat_id in objs:
            continue
        objs[chat_id] = SuccessResponse(chat_id=chat_id,messages=[],timestamp=time_stamp)
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
    print(f"{sender} sent {receiver_id}: {content}")
    await manager.send_message(jsonable_encoder(objs),receiver_id)
    await connection.set_delivery_status(message_ids)


@wsroute.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket,session: Annotated[dict|None, Depends(verify_jwt)]):
    print(manager)
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")

    await websocket.accept()
    client_id = session["user_id"]
    username = session["user"]
    print(f"{username} connected")
    connect_status = await manager.connect(client_id,websocket)
    if not connect_status:
        return
    else:
        pending_messages = await connection.check_pending_messages(client_id)
        if pending_messages:
            # print(pending_messages)
            await deliver_pending_messages(pending_messages,client_id)
    try:
        while True:
            data = await websocket.receive_text()
            data = MessageManager(data)
            print(f"{client_id} said {data}")
            client_id = data.get_client_id()
            message = data.get_message()
            chat_id = data.get_chat_id()
            await user_send_message(client_id,chat_id,message)
    except WebSocketDisconnect:
        await manager.disconnect(client_id)
        print(f"{username} disconnected")
    except Exception as e:
        print(e)

