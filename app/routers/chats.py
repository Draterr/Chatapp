from uuid import uuid4
import json
from typing import Annotated
from fastapi import APIRouter, HTTPException, Depends
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel
from db import connection
from routers.users import verify_jwt
from routers.websocket import manager

chats = APIRouter()

class CHAT(BaseModel):
    chat_name: str
    chat_users: list[int]
    is_dm: bool

@chats.post("/create_chat",tags=["chats"])
async def create_chat(chat: CHAT, session: Annotated[dict|None, Depends(verify_jwt)]):
    if session is None:
        raise HTTPException(status_code=403,detail="Unauthorized")
    if chat.is_dm:
        dm_key = (min(chat.chat_users),max(chat.chat_users))
    dm_key = sorted(dm_key)
    chat_id = uuid4()
    user_id = session["user_id"]
    if user_id not in chat.chat_users:
        chat.chat_users.append(user_id)
    status = await connection.insert_chat(str(chat_id),chat.chat_name,chat.chat_users)
    if not status:
        raise HTTPException(status_code=400,detail="DB Insert went wrong")
    await manager.pubsub_instance.publish_message("control",json.dumps({"type":"create_channel","chat_id":str(chat_id),"user_ids":chat.chat_users}))
    return {"chat_id":str(chat_id)}

@chats.get("/chats",tags=["chats"])
async def get_chats(session: Annotated[dict|None , Depends(verify_jwt)]):
    if session is None:
        raise HTTPException(status_code=403,detail="Unauthorized")
    user_id = session["user_id"]
    res = await connection.get_chats_info(user_id)
    return res

@chats.get("/chat/{chat_id}/messages",tags=["chats"])
async def get_chat_message(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str, limit: int=50, offset: int=0):
    if session is None:
        raise HTTPException(status_code=403,detail="Unauthorized")
    user_id = session["user_id"]
    chat_messages = await connection.get_chat_message(chat_id,user_id,limit,offset)
    return chat_messages

# @chats.post("/chat/delete_chat",tags=["chats"])
# async def delete_chat(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str):
#     if session is None:
#         raise HTTPException(status_code=403,detail="Unauthorized")
#     uid = session["user_id"]
#     existing_chat = await connection.get_chats(uid)
#     if chat_id not in existing_chat:
#         raise HTTPException(status_code=403,detail="You are not a member of this chat!")
#
