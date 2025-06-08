from fastapi import APIRouter, Cookie, Response
from pydantic import BaseModel
import asyncio
from app.db import connection
from os import getenv
from app.dependecies import response_object, json_response
import jwt
from datetime import datetime,timedelta,timezone

router = APIRouter()
json_res = json_response()

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
    return (encoded_jwt,cookie_expire_date)



@router.post("/register",tags=["users"])
async def register(user: User):
    response = response_object()
    if len(user.username) < 1:
        response.set_attribute(400,"Invalid Username","username can't be empty")
        return json_res.create_error_message("error",response)
    if len(user.password) < 1:
        response.set_attribute(400,"Invalid Password","password can't be empty")
        return json_res.create_error_message("error",response)
    if len(user.username) > 255:
        response.set_attribute(400,"Invalid username","username has to be within 255 characters")
        return json_res.create_error_message("error",response)
    role = "user"
    status = await connection.insert_user(user.username,user.password,role,user.username)
    if status == "duplicate":
        response.set_attribute(400,"Duplicate username","username already exists")
        return json_res.create_error_message("error",response)
    response.set_attribute(200,"Success","Successfully Registed!")
    return json_res.create_message("success",response)

@router.post("/login",tags=["users"])
async def login(user: User,response: Response):
    res_obj = response_object()
    if len(user.username) < 1:
        res_obj.set_attribute(400,"Invalid Username","username can't be empty")
        return json_res.create_error_message(response)
    if len(user.password) < 1:
        res_obj.set_attribute(400,"Invalid Password","password can't be empty")
        return json_res.create_error_message(response)
    status,role,user_id = await connection.check_credentials(user.username,user.password)
    if status == True:
        data = {"user":user.username,"role":role,"user_id":user_id}
        jwt_token,cookie_expire_date = create_access_token(data)
        response.set_cookie(key="session",value=jwt_token,httponly=True,secure=True,expires=cookie_expire_date)
        return "Cookie Set!"
    elif not status:
        return "incorrect username or password."
