from datetime import datetime,timezone
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import websocket
import json
import logging
from app.db import connection
from app.dependencies import json_response

wsroute = APIRouter()
json_res = json_response()

class connection_manager:
    def __init__(self):
        self.active_connections = {}

    def connect(self,client_id:int,websocket:WebSocket):
        if client_id in self.active_connections:
            return None
        self.active_connections.update({client_id:websocket})
        return True

    async def send_message(self,message:str,receiver_id:int):
        websocket = self.active_connections[receiver_id]
        await websocket.send_text(message)

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

#ToDO:
#the client id should be derived from the cookie
@wsroute.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket,client_id: int):
    await websocket.accept()
    print(f"{client_id} connected")
    connect_status = manager.connect(client_id,websocket)
    if not connect_status:
        return "existing connection"
    else:
        pending_messages = await connection.check_pending_messages(2)
        await send_pending_messages(pending_messages,client_id)
    try:
        print(manager)
        while True:
            data = await websocket.receive_text()
            data = MessageManager(data)
            print(f"{client_id} said {data}")
            client_id = data.get_client_id()
            message = data.get_message()
            chat_id = data.get_chat_id()
            time_sent = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            res = await connection.insert_message(client_id,time_sent,chat_id,message)
            print(res)
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        print(manager)
        print(f"{client_id} disconnected")

async def send_pending_messages(messages:tuple|None,receiver_id:int):
    if not messages:
        return
    for message in messages:
        chat_id = message[0]
        time_sent = message[1].strftime("%Y-%m-%d %H:%M:%S")
        content = message[2]
        res = json_res.create_message_json(chat_id,time_sent,content)
        print(f"sent {receiver_id}")
        await manager.send_message(res,receiver_id)
