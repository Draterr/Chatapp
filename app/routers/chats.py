from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.db import connection

chats = APIRouter()

class CHAT(BaseModel):
    chat_id: str
    chat_name: str
    chat_users: list[int]
    is_dm: bool

@chats.post("/create_chat",tags=["chats"])
async def create_chat(chat: CHAT):
    if chat.is_dm and len(chat.chat_users) > 1:
        raise HTTPException(status_code=400,detail="Direct messages can only have one user!")
    status = await connection.insert_chat(chat.chat_id,chat.chat_name,chat.chat_users)
    if not status:
        raise HTTPException(status_code=400,detail="DB Insert went wrong")
    return {"Success":"Successfully Created Chat!"}

