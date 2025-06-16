import asyncio
import aiomysql
from typing import *
import os
from passlib.hash import bcrypt
import logging
import uuid


user = os.getenv("DB_USER")
password = os.getenv("DB_PASSWORD")
host = os.getenv("DB_HOST")
database = os.getenv("DB_DATABASE")
log = logging.getLogger(__name__)
logging.basicConfig(filename="log.log",encoding="utf-8",level=logging.DEBUG)

class Database:
    def __init__(self,user: str|None,password:str|None,database:str|None,host:str|None):
        self.user = user
        self.password = password
        self.database = database 
        self.host = host

    async def initialize_connection(self,min_pool_size:int ,max_pool_size:int):
        try:
            self.pool = await aiomysql.create_pool(host=self.host,
                                               user=self.user,
                                               password=self.password,
                                               port=3307,
                                               db=self.database,
                                               minsize=min_pool_size,
                                               maxsize=max_pool_size,
                                               )
        except Exception as e:
            log.warning(e)

    async def check_credentials(self,username:str,password:str):
        prepared_query = "SELECT password,role,user_id FROM users WHERE username= %s"
        try:
            async with self.pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(prepared_query,username)
                    stored_password = await cur.fetchone() #fetchone returns tuple 2nd element is password hash
                    
                    if stored_password and bcrypt.verify(password,stored_password[0]):
                        return (True,stored_password[1],stored_password[2])
                    else:
                        return (False,None,None)
        except Exception as e:
            log.warning(e)
            return (e,None,None)

    async def insert_user(self,username:str,password:str,role:str,display_name:str):
        prepared_query = "INSERT INTO users(username,password,role,display_name) VALUES(%s,%s,%s,%s)"
        hashed_password = bcrypt.using(rounds=12).hash(password)
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(prepared_query,(username,hashed_password,role,display_name))
                    await conn.commit()
                except aiomysql.IntegrityError:
                    return "duplicate"

    async def insert_message(self,sender_id:int,time_sent,chat_id:str,message:str):
        message_id = uuid.uuid4()
        insert_message = "INSERT INTO messages(message_id,sent_by,time_sent,chat_id,content) VALUES(%s,%s,%s,%s,%s)"
        get_users = "SELECT user_id FROM chat_users WHERE chat_id = %s AND user_id != %s"
        insert_message_status = "INSERT INTO message_status(message_id,receiver_id) VALUES(%s,%s)"
        data = []
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(insert_message,(message_id,sender_id,time_sent,chat_id,message))
                    await cur.execute(get_users,(chat_id,sender_id))
                    user_ids = await cur.fetchmany()
                    print(user_ids)
                    for i in user_ids:
                        tmp = []
                        user_id = i[0]
                        tmp.append(message_id)
                        tmp.append(user_id)
                        data.append(tuple(tmp))
                    print(data)
                    await cur.executemany(insert_message_status,data)
                    await conn.commit()
                    return f"Inserted message {sender_id} to {chat_id}"
                except Exception as e:
                    log.warning(e)
                    return e

    async def insert_chat(self,chat_id:str,chat_name:str,chat_users:list[int]):
        insert_chat_prepared_query = "INSERT INTO chats(chat_id,chat_name) VALUES(%s,%s)"
        insert_chat_users_prepared_query = "INSERT INTO chat_users(chat_id,user_id) VALUES(%s,%s)"
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(insert_chat_prepared_query,(chat_id,chat_name))
                    await conn.commit()
                    for users in chat_users:
                        await cur.execute(insert_chat_users_prepared_query,(chat_id,users))
                    return f"Inserted chats {chat_id}"
                except Exception as e:
                    log.warning(e)
                    return e

    async def check_pending_messages(self,client_id:int):
        prepared_query = "SELECT * FROM messages WHERE"
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(prepared_query,username)

connection = Database(user,password,database,host)
