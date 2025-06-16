from fastapi import APIRouter, Cookie, Response
from pydantic import BaseModel
import asyncio
from app.db import connection
from os import getenv, system
from app.dependencies import response_object, json_response
import jwt
from datetime import datetime,timedelta,timezone
import logging
import sys

router = APIRouter()
json_res = json_response()
root = logging.getLogger(__name__)
logging.basicConfig(filename="log.log",encoding="utf-8",level=logging.DEBUG)

JWT_SECRET_KEY = getenv("JWT_SECRET_KEY")
ALGO = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 4320

class User(BaseModel):
    username: str
    password: str

class Profile(BaseModel):
    display_name: str
    avatar_url: str | None

def create_access_token(data:dict):
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    data.update({"exp":expire})
    encoded_jwt = jwt.encode(data,JWT_SECRET_KEY,algorithm=ALGO)
    cookie_expire_date = expire.strftime('%A, %d %b %Y %H:%M:%S GMT')
    root.debug(f"JWT Token Created {encoded_jwt}")
    return (encoded_jwt,cookie_expire_date)



@router.post("/register",tags=["users"])
async def register(user: User):
    response = response_object()
    if len(user.username) < 1:
        root.info("Received an invalid username")
        response.set_attribute(400,"Invalid Username","username can't be empty")
        return json_res.create_message("error",[response])
    if len(user.password) < 1:
        root.info("Received an invalid password")
        response.set_attribute(400,"Invalid Password","password can't be empty")
        return json_res.create_message("error",[response])
    if len(user.username) > 255:
        root.info("Received a username that was too long")
        response.set_attribute(400,"Invalid username","username has to be within 255 characters")
        return json_res.create_message("error",[response])
    role = "user"
    status = await connection.insert_user(user.username,user.password,role,user.username)
    if status == "duplicate":
        response.set_attribute(400,"Duplicate username","username already exists")
        return json_res.create_message("error",[response])
    response.set_attribute(200,"Success","Successfully Registed!")
    root.debug(f"new user created {user.username}")
    return json_res.create_message("success",[response])

@router.post("/login",tags=["users"])
async def login(user: User,response: Response):
    res_obj = response_object()
    if len(user.username) < 1:
        res_obj.set_attribute(400,"Invalid Username","username can't be empty")
        return json_res.create_message([response])
    if len(user.password) < 1:
        res_obj.set_attribute(400,"Invalid Password","password can't be empty")
        return json_res.create_message([response])
    status,role,user_id = await connection.check_credentials(user.username,user.password)
    if status == True:
        data = {"user":user.username,"role":role,"user_id":user_id}
        jwt_token,cookie_expire_date = create_access_token(data)
        response.set_cookie(key="session",value=jwt_token,httponly=True,secure=True,expires=cookie_expire_date)
        return "Cookie Set!"
    elif status == False:
        return "incorrect username or password."
    else:
        return status
