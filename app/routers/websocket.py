from fastapi import APIRouter, WebSocket
import websocket

wsroute = APIRouter()

class connection_manager:
    def __init__(self):
        self.active_connections = {}
    def connect(self,client_id:int,websocket:WebSocket):
        if client_id in self.active_connections:
            return None
        return True
        self.active_connections.update({"client_id":websocket})
    async def send_message(self,message:str,websocket:WebSocket):
        await websocket.send_text(message)

    async def broadcast(self,message:str):
        for i in self.active_connections:
            await i.send_text(message) 
        

connection = connection_manager()

#the client id should be derived from the cookie
@wsroute.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket,client_id: int):
    await websocket.accept()
    connect_status = connection.connect(client_id,websocket)
    if not connect_status:
        return "existing connection"
    while True:
        data = await websocket.receive_text()
