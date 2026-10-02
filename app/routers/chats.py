from uuid import uuid4
import json
from loguru import logger
from typing import Annotated, Literal
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from db import connection
from routers.users import verify_jwt
from routers.websocket import manager

chats = APIRouter()


class CHAT(BaseModel):
    chat_name: str
    chat_users: list[int]
    is_dm: bool

class ChatId(BaseModel):
    chat_id: str


async def announce(chat_id:str,*,actor_id:int,event:str,target_id:int|None=None,data:dict|None=None):
    """Write a system event into the chat and fan it out to live sockets.

    Never allowed to fail the request that caused it: the change itself is already
    committed by this point, so a broken announcement is cosmetic and must not turn a
    successful action into a 500. `target_id` is None for an event with no subject user
    and `data` carries that event's own payload instead (a rename's new name).

    Both are keyword-only with defaults so a bad call can't raise a TypeError at the call
    site, outside this try -- which is exactly how the rename announcement used to 500.
    """
    try:
        frame = await connection.insert_system_message(chat_id=chat_id,actor_id=actor_id,
                                                      event=event,target_id=target_id,data=data)
        await manager.pubsub_instance.publish_message(chat_id,json.dumps(frame))
    except Exception:
        logger.exception(f"failed to announce {event} in {chat_id}")

@chats.post("/create_chat",tags=["chats"])
async def create_chat(chat: CHAT, session: Annotated[dict|None, Depends(verify_jwt)]):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    chat_id = uuid4()
    user_id = session["user_id"]
    if user_id not in chat.chat_users:
        chat.chat_users.append(user_id)
    dm_key = None
    if chat.is_dm:
        if len(chat.chat_users) != 2:
            raise HTTPException(status_code=400,detail="DM can only be created between 2 users")
        lo, hi = sorted(chat.chat_users)
        dm_key = f"{lo}-{hi}"
    await connection.insert_chat(str(chat_id),chat.chat_name,chat.chat_users,chat.is_dm,dm_key,user_id if chat.is_dm != True else None)
    await manager.pubsub_instance.publish_message("control",json.dumps({"type":"create_channel","chat_id":str(chat_id),"user_ids":chat.chat_users}))
    return {"chat_id":str(chat_id)}

@chats.get("/chats",tags=["chats"])
async def get_chats(session: Annotated[dict|None , Depends(verify_jwt)]):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    user_id = session["user_id"]
    res = await connection.get_chats_info(user_id)
    return res

@chats.get("/chat/{chat_id}/messages",tags=["chats"])
async def get_chat_message(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str, limit: int=50, offset: int=0):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    user_id = session["user_id"]
    chat_messages = await connection.get_chat_message(chat_id,user_id,limit,offset)
    return chat_messages

@chats.post("/chat/delete_chat",tags=["chats"])
async def delete_chat(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:ChatId):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]
    existing_chat = await connection.get_chats(uid)
    if chat_id.chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    chat_info = await connection.get_chat_info(chat_id.chat_id)
    if chat_info["is_dm"]:
        raise HTTPException(status_code=403,detail="You can't delete a DM chat!")

    user_role = await connection.check_user_role(chat_id=chat_id.chat_id,user_id=uid)
    if user_role != "admin":
        raise HTTPException(status_code=403,detail="You are not an admin of this chat!")
    status = await connection.delete_chat(chat_id=chat_id.chat_id)
    if status:
        await manager.pubsub_instance.publish_message("control",json.dumps({"type":"delete_channel","chat_id":str(chat_id.chat_id)}))
        return {"message":"Chat deleted successfully"}

@chats.post("/chat/{chat_id}/leave",tags=["chats"])
async def leave_chat(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]
    existing_chat = await connection.get_chats(uid)
    if chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    chat_info = await connection.get_chat_info(chat_id)
    if chat_info["is_dm"]:
        raise HTTPException(status_code=403,detail="You can't leave a DM chat!")

    user_role = await connection.check_user_role(chat_id=chat_id,user_id=uid)
    if user_role == "admin":
        admin_count = await connection.get_admin_count(chat_id=chat_id)
        if admin_count <= 1:
            raise HTTPException(status_code=403,detail="There must be at least one admin in the chat!")
    status = await connection.leave_chat(chat_id=chat_id,user_id=uid)
    if status:
        await announce(chat_id,actor_id=uid,event="member_left",target_id=uid)
        await manager.pubsub_instance.publish_message("control",json.dumps({"type":"remove_member","chat_id":str(chat_id),"user_id":uid}))
        return {"message":"Left the chat successfully"}

@chats.post("/chat/{chat_id}/kick",tags=["chats"])
async def kick_user(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str,user_id:int):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]
    existing_chat = await connection.get_chats(uid)
    if chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    chat_info = await connection.get_chat_info(chat_id)
    if chat_info["is_dm"]:
        raise HTTPException(status_code=403,detail="You can't kick someone from a DM chat!")

    user_role = await connection.check_user_role(chat_id=chat_id,user_id=uid)
    kick_role = await connection.check_user_role(chat_id=chat_id,user_id=user_id)
    if user_role == "user" and kick_role == "admin":
        raise HTTPException(status_code=403,detail="You can't kick an admin from the chat!")
    if user_role == "user" and kick_role == "user":
        raise HTTPException(status_code=403,detail="You can't kick a user from the chat!")
    if user_role == "admin" and kick_role == "admin":
        raise HTTPException(status_code=403,detail="You can't kick an admin from the chat!")

    status = await connection.leave_chat(chat_id=chat_id,user_id=user_id)
    if status:
        await announce(chat_id,actor_id=uid,event="member_kicked",target_id=user_id)
        await manager.pubsub_instance.publish_message("control",json.dumps({"type":"remove_member","chat_id":str(chat_id),"user_id":user_id}))
        return {"message":"User kicked from the chat successfully"}

@chats.post("/chat/{chat_id}/rename",tags=["chats"])
async def rename_chat(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str, new_name:str):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]
    existing_chat = await connection.get_chats(uid)
    if chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    chat_info = await connection.get_chat_info(chat_id)
    if chat_info["is_dm"]:
        raise HTTPException(status_code=403,detail="You can't rename a DM chat!")

    user_role = await connection.check_user_role(chat_id=chat_id,user_id=uid)
    if user_role != "admin":
        raise HTTPException(status_code=403,detail="You are not an admin of this chat!")

    status = await connection.rename_chat(chat_id=chat_id,new_name=new_name)
    if status:
        await announce(chat_id,actor_id=uid,event="chat_renamed",data={"new_name":new_name})
        await manager.pubsub_instance.publish_message("control",json.dumps({"type":"rename_channel","chat_id":str(chat_id),"new_name":new_name}))
        return {"message":"Chat renamed successfully"}

@chats.post("/chat/{chat_id}/add_member",tags=["chats"])
async def add_member(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str,user_id:list[int]):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]

    #check if the user is a member of the chat
    existing_chat = await connection.get_chats(uid)
    if chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    chat_info = await connection.get_chat_info(chat_id)
    if chat_info["is_dm"]:
        raise HTTPException(status_code=403,detail="You can't add members to a DM!")

    #check if the user is an admin of the chat
    user_role = await connection.check_user_role(chat_id=chat_id,user_id=uid)
    if user_role != "admin":
        raise HTTPException(status_code=403,detail="You are not an admin of this chat!")

    #check if the user to be added is already a member of the chat
    for i in user_id:
        new_user_role = await connection.get_user_role(chat_id=chat_id,user_id=i)
        if new_user_role is not None:
            raise HTTPException(status_code=400,detail=f"User {i} is already a member of this chat!")

    await connection.add_members(chat_id=chat_id,user_ids=user_id)
    for i in user_id:
        await announce(chat_id,actor_id=uid,event="member_added",target_id=i)
        await manager.pubsub_instance.publish_message("control",json.dumps({"type":"add_member","chat_id":str(chat_id),"user_id":i}))
    return {"message":"Member added successfully"}

@chats.post("/chat/change_role",tags=["chats"])
async def change_role(session: Annotated[dict|None , Depends(verify_jwt)],chat_id:str,user_id:int,new_role:Literal["admin","user"]):
    if session is None:
        raise HTTPException(status_code=401,detail="Unauthorized")
    uid = session["user_id"]

    #check if the user is a member of the chat
    existing_chat = await connection.get_chats(uid)
    if chat_id not in existing_chat:
        raise HTTPException(status_code=403,detail="You are not a member of this chat!")

    #check if the user is an admin of the chat
    user_role = await connection.check_user_role(chat_id=chat_id,user_id=uid)
    if user_role != "admin":
        raise HTTPException(status_code=403,detail="You are not an admin of this chat!")

    #check if there is at least one admin in the chat
    admin_count = await connection.get_admin_count(chat_id=chat_id)
    if admin_count <= 1 and new_role != "admin":
        raise HTTPException(status_code=403,detail="There must be at least one admin in the chat!")
    await connection.change_role(chat_id=chat_id,user_id=user_id,new_role=new_role)
    await announce(chat_id,actor_id=uid,event="promoted" if new_role == "admin" else "demoted",target_id=user_id)
    return {"message":"Role changed successfully"}

# @chats.post("/edit/edit_message",tags=["chats"])
# async def edit_message(self,*,session: Annotated[dict|None, Depends(verify_jwt)],chat_id:str,message_id: str,new_content:str):
#     if session is None:
#         raise HTTPException(status_code=401,detail="Unauthorized")
#     uid = session["user_id"]
#
#     #check if the user is a member of the chat
#     existing_chat = await connection.get_chats(uid)
#     if chat_id not in existing_chat:
#         raise HTTPException(status_code=403,detail="You are not a member of this chat!")
#
#     message_owner = await connection.check_message_ownership(message_id=message_id)
#     if message_owner != uid:
#         raise HTTPException(status_code=403,detail="You do not own this message!")
#     
#     await connection.edit_message(message_id=message_id,new_content=new_content)
#     await announce(chat_id=chat_id,actor_id=uid,event="edit_message")
#
