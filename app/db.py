import aiomysql
from loguru import logger
from typing import List
import os
from contextlib import asynccontextmanager
from fastapi import HTTPException
from passlib.hash import bcrypt
import uuid

user = os.getenv("DB_USER")
password = os.getenv("DB_PASSWORD")
database = os.getenv("DB_DATABASE")
APP_ENV = os.getenv("APP_ENV")
if APP_ENV != "DOCKER":
    host = "127.0.0.1"
    port = 3307
else:
    host = "mysql_db"
    port = 3306

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
                                               port=port,
                                               db=self.database,
                                               minsize=min_pool_size,
                                               maxsize=max_pool_size,
                                               autocommit=False
                                               )
        except Exception as e:
            logger.exception("pool initialization failed")
            raise RuntimeError(e)

    @asynccontextmanager
    async def _transaction(self):
        # acquire a pooled connection + cursor, commit on clean exit,
        # roll back on any exception, and always release back to the pool
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    yield cur
                    await conn.commit()
                except Exception:
                    await conn.rollback()
                    raise

    async def check_credentials(self,username:str,password:str):
        query = "SELECT password,role,user_id FROM users WHERE username = %s"
        try:
            async with self._transaction() as cur:
                await cur.execute(query,(username,))
                stored_password = await cur.fetchone()
        except Exception:
            raise HTTPException(status_code=400,detail="Something went wrong with SQL query")

        if stored_password and bcrypt.verify(password,stored_password[0]):
            return (stored_password[1],stored_password[2])
        else:
            raise HTTPException(status_code=403,detail="Incorrect username or password")

    async def insert_user(self,username:str,password:str,role:str,display_name:str):
        query = "INSERT INTO users(username,password,role,display_name) VALUES(%s,%s,%s,%s)"
        hashed_password = bcrypt.using(rounds=12).hash(password)
        try:
            async with self._transaction() as cur:
                await cur.execute(query,(username,hashed_password,role,display_name))
        except aiomysql.IntegrityError:
            raise HTTPException(status_code=400,detail="username already exists")

    async def get_user_profile(self,user_id:int):
        query = "SELECT display_name,avatar_url FROM users WHERE user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(user_id,))
            row = await cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404,detail="User not found")
            return {"display_name":row[0],"avatar_url":row[1]}

    #WEBSOCKET RELATED
    async def insert_message(self,sender_id:int,time_sent,chat_id:str,message:str):
        message_id = uuid.uuid4()
        insert_message = "INSERT INTO messages(message_id,sent_by,time_sent,chat_id,content) VALUES(%s,%s,%s,%s,%s)"
        get_users = "SELECT user_id FROM chat_users WHERE chat_id = %s AND user_id != %s"
        insert_message_status = "INSERT INTO message_status(message_id,receiver_id) VALUES(%s,%s)"
        async with self._transaction() as cur:
            await cur.execute(insert_message,(message_id,sender_id,time_sent,chat_id,message))
            await cur.execute(get_users,(chat_id,sender_id))
            user_ids = await cur.fetchall()
            data = [(message_id, row[0]) for row in user_ids]
            await cur.executemany(insert_message_status,data)
        return message_id

    async def insert_chat(self,chat_id:str,chat_name:str,chat_users:list[int]):
        insert_chat = "INSERT INTO chats(chat_id,chat_name) VALUES(%s,%s)"
        insert_chat_users = "INSERT INTO chat_users(chat_id,user_id) VALUES(%s,%s)"
        try:
            async with self._transaction() as cur:
                await cur.execute(insert_chat,(chat_id,chat_name))
                for user_id in chat_users:
                    await cur.execute(insert_chat_users,(chat_id,user_id))
                return True
        except Exception:
            logger.exception("insert_chat failed")
            raise HTTPException(status_code=400,detail="Something went wrong with creating chat")

    async def check_pending_messages(self,client_id:int):
        query = ("SELECT b.chat_id,b.time_sent,b.content,b.sent_by,a.message_id,c.display_name "
                 "FROM message_status as a "
                 "INNER JOIN messages as b ON a.message_id = b.message_id "
                 "INNER JOIN users as c ON c.user_id = b.sent_by "
                 "WHERE receiver_id = %s AND status = 'NOT-DELIVERED'")
        async with self._transaction() as cur:
            await cur.execute(query,(client_id,))
            return await cur.fetchall()   # empty tuple when nothing is pending

    async def set_delivery_status(self,message_id:List[str],receiver_id:int):
        query = "UPDATE message_status SET status = 'DELIVERED' WHERE message_id = %s AND receiver_id = %s"
        async with self._transaction() as cur:
            for mid in message_id:
                await cur.execute(query,(mid,receiver_id))

    async def get_chats(self,user_id:int) -> List[str]:
        query = "SELECT chat_id FROM chat_users WHERE user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(user_id,))
            return await cur.fetchall()


connection = Database(user,password,database,host)
