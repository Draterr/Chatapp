from datetime import datetime,timezone
from typing import Annotated
from fastapi import APIRouter, WebSocket, WebSocketDisconnect,Depends,HTTPException
from fastapi.encoders import jsonable_encoder
import json
from typing import List
from pydantic import BaseModel
from app.db import connection
from app.routers.users import verify_jwt

wsroute = APIRouter()

class SuccessResponse(BaseModel):
    type: str
    content: dict | List
    timestamp:str

class ErrorResponse(BaseModel):
    type: str
    code:str
    detail: str 

class connection_manager:
    def __init__(self):
        self.active_connections = {}

    def connect(self,client_id:int,websocket:WebSocket):
        if client_id in self.active_connections:
            return None
        self.active_connections.update({client_id:websocket})
        print(self.active_connections)
        return True

    async def send_message(self,message:SuccessResponse | ErrorResponse,receiver_id:int):
        websocket = self.active_connections[receiver_id]
        await websocket.send_json(message,mode="text")

    async def broadcast(self,message:str):
        for i in self.active_connections:
            await i.send_text(message) 

    def disconnect(self,client_id:int):
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
    time_sent = time.strftime("%Y-%m-%d %H:%M:%S")
    insert_status = await connection.insert_message(sender_id,time_sent,chat_id,message)
    if insert_status != True:
        response = ErrorResponse(type="error",code="DB INSERT ERROR",detail=insert_status)
        await manager.send_message(response,sender_id)
    else:
        time_stamp = time.strftime("%H:%M:%S")
        response = jsonable_encoder(SuccessResponse(type="ack",content={"message_id":message,"chat_id":chat_id},timestamp=time_stamp))


async def deliver_pending_messages(messages:tuple|None,receiver_id:int):
    if not messages:
        return
    time_stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    res = []
    message_ids = []
    for message in messages:
        tmp = {}
        chat_id = message[0]
        time_sent = message[1].strftime("%Y-%m-%d %H:%M:%S")
        content = message[2]
        sender = message[3]
        message_ids.append(message[4])
        tmp.update({"chat_id":chat_id,"time_sent":time_sent,"content":content,"sender":sender})
        res.append(tmp)
    response = jsonable_encoder(SuccessResponse(type="update",content=res,timestamp=time_stamp))
    print(f"{sender} sent {receiver_id}: {content}")
    await manager.send_message(response,receiver_id)
    await connection.set_delivery_status(message_ids)


@wsroute.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket,session: Annotated[dict|None, Depends(verify_jwt)]):
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")

    await websocket.accept()
    client_id = session["user_id"]
    username = session["user"]
    print(f"{username} connected")
    connect_status = manager.connect(client_id,websocket)
    if not connect_status:
        raise HTTPException(status_code=400,detail="Exisiting Connection")
    else:
        pending_messages = await connection.check_pending_messages(client_id)
        print(pending_messages)
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
        manager.disconnect(client_id)
        print(manager)
        print(f"{client_id} disconnected")


