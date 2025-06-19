import aiomysql
from typing import *
import os
from fastapi import HTTPException
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

    async def get_connection(self):
        try:
            conn = await self.pool.acquire()
            cur = await conn.cursor()
            return (conn,cur)
        except Exception:
            raise RuntimeError("SQL connection failed") 

    async def free_connection(self,connection,cursor):
        try:
            await cursor.close()
            self.pool.release(connection)
        except Exception:
            raise RuntimeError("Failed to free connection/cursor")


    async def initialize_connection(self,min_pool_size:int ,max_pool_size:int):
        try:
            self.pool = await aiomysql.create_pool(host=self.host,
                                               user=self.user,
                                               password=self.password,
                                               port=3307,
                                               db=self.database,
                                               minsize=min_pool_size,
                                               maxsize=max_pool_size,
                                               autocommit=True
                                               )
        except Exception as e:
            log.warning(e)

    async def check_credentials(self,username:str,password:str):
        prepared_query = "SELECT password,role,user_id FROM users WHERE username= %s"
        conn,cur = await self.get_connection()
        try:
            await cur.execute(prepared_query,username)
            stored_password = await cur.fetchone()
        except Exception as e:
            print(e)
            raise HTTPException(status_code=400,detail="Something went wrong with SQL query")
        finally:
            await self.free_connection(conn,cur)
        
        if stored_password and bcrypt.verify(password,stored_password[0]):
            return (stored_password[1],stored_password[2])
        else:
            raise HTTPException(status_code=403,detail="Incorrect username or password")

    async def insert_user(self,username:str,password:str,role:str,display_name:str):
        prepared_query = "INSERT INTO users(username,password,role,display_name) VALUES(%s,%s,%s,%s)"
        hashed_password = bcrypt.using(rounds=12).hash(password)
        conn,cur = await self.get_connection()
        try:
            await cur.execute(prepared_query,(username,hashed_password,role,display_name))
            # await conn.commit()
        except aiomysql.IntegrityError:
            raise HTTPException(status_code=400,detail="username already exists")
        finally:
            await self.free_connection(conn,cur)

    #WEBSOCKET RELATED
    async def insert_message(self,sender_id:int,time_sent,chat_id:str,message:str):
        message_id = uuid.uuid4()
        insert_message = "INSERT INTO messages(message_id,sent_by,time_sent,chat_id,content) VALUES(%s,%s,%s,%s,%s)"
        get_users = "SELECT user_id FROM chat_users WHERE chat_id = %s AND user_id != %s"
        insert_message_status = "INSERT INTO message_status(message_id,receiver_id) VALUES(%s,%s)"
        data = []
        conn,cur = await self.get_connection()
        try:
            await cur.execute(insert_message,(message_id,sender_id,time_sent,chat_id,message))
            await cur.execute(get_users,(chat_id,sender_id))
            user_ids = await cur.fetchall()
            print(user_ids)
            for i in user_ids:
                tmp = []
                user_id = i[0]
                tmp.append(message_id)
                tmp.append(user_id)
                data.append(tuple(tmp))
            await cur.executemany(insert_message_status,data)
            # await conn.commit()
            return True
        except Exception as e:
            log.warning(e)
            return e 
        finally:
            await self.free_connection(conn,cur)

    async def insert_chat(self,chat_id:str,chat_name:str,chat_users:list[int]):
        insert_chat_prepared_query = "INSERT INTO chats(chat_id,chat_name) VALUES(%s,%s)"
        insert_chat_users_prepared_query = "INSERT INTO chat_users(chat_id,user_id) VALUES(%s,%s)"
        conn,cur = await self.get_connection()
        try:
            await cur.execute(insert_chat_prepared_query,(chat_id,chat_name))
            # await conn.commit()
            for users in chat_users:
                await cur.execute(insert_chat_users_prepared_query,(chat_id,users))
            return True
        except Exception as e:
            log.warning(e)
            raise HTTPException(status_code=400,detail="Something went wrong with creating chat")
        finally:
            await self.free_connection(conn,cur)

    async def check_pending_messages(self,client_id:int):
        prepared_query = "SELECT b.chat_id,b.time_sent,b.content,b.sent_by,a.message_id FROM message_status as a INNER JOIN messages as b ON a.message_id = b.message_id WHERE receiver_id = %s AND status = 'NOT-DELIVERED'"
        conn,cur = await self.get_connection()
        try:
            await cur.execute(prepared_query,(client_id))
            messages = await cur.fetchall()
            print(f"{cur.rowcount} are waiting to be delivered!")
            if cur.rowcount < 1:
                return None
            return messages
        except Exception as e:
            log.warning(e)
            return False
        finally:
            await self.free_connection(conn,cur)

    async def set_delivery_status(self,message_id:List[str]):
        prepared_query = "UPDATE message_status SET status = 'DELIVERED' WHERE message_id = %s"
        conn,cur = await self.get_connection()
        count = 0
        try:
            for i in message_id:
                await cur.execute(prepared_query,(i))
                count += cur.rowcount
            # await conn.commit()
            print(str(count)+" Row Updated")
            return True
        except Exception as e:
            log.warning(e)
            return False
        finally:
            await self.free_connection(conn,cur)



connection = Database(user,password,database,host)
