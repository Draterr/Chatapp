from fastapi import APIRouter
from app.dependencies import response_object, json_response
from pydantic import BaseModel
from app.db import connection

chats = APIRouter()
json_res = json_response()

class CHAT(BaseModel):
    chat_id: str
    chat_name: str
    chat_users: list[int]
    is_dm: bool

@chats.post("/create_chat",tags=["chats"])
async def create_chat(chat: CHAT):
    response = response_object()
    if chat.is_dm and len(chat.chat_users) > 1:
        response.set_attribute(400,"Invalid Users","Direct messages can only have one user!")
        return json_res.create_status("Error",[response])
    status = await connection.insert_chat(chat.chat_id,chat.chat_name,chat.chat_users)
    if not status:
        response.set_attribute(400,"Invalid chat","Something Went Wrong")
        return json_res.create_status("Error",[response])
    response.set_attribute(200,"Success","Success")
    return json_res.create_status("Success",[response])

