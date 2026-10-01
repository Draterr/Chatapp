import aiomysql
from loguru import logger
from typing import List
import os
from contextlib import asynccontextmanager
from fastapi import HTTPException
from passlib.hash import bcrypt
import uuid
from datetime import datetime,timezone

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

def iso_utc(dt):
    """DATETIME columns hold naive UTC; stamp the offset so clients can localize."""
    if dt is None or isinstance(dt,str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()

# Known system events. `text` is a server-rendered fallback so a client that doesn't
# know an event can still show something; clients that do know it build their own copy
# from actor_name/target_name, which stays correct if a display name later changes.
SYSTEM_EVENTS = ("member_added","member_left","promoted","demoted")

def system_text(event,actor_name,target_name):
    """The server-rendered fallback wording, stored in `content`."""
    if event == "member_added":
        return f"{actor_name} added {target_name}"
    if event == "member_left":
        return f"{actor_name} left"
    if event == "promoted":
        return f"{actor_name} made {target_name} an admin"
    return f"{actor_name} removed {target_name} as an admin"

def system_frame(message_id,chat_id,event,actor_id,actor_name,target_id,target_name,text,time_sent):
    """The single definition of a system message's wire shape -- live and from history."""
    return {"type":"system","message_id":message_id,"chat_id":chat_id,"event":event,
            "actor_id":actor_id,"actor_name":actor_name,
            "target_id":target_id,"target_name":target_name,
            "message":text,"time_sent":time_sent}

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
                                               autocommit=False,
                                               init_command="SET time_zone = '+00:00'"
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
        async with self._transaction() as cur:
            await cur.execute(query,(username,))
            stored_password = await cur.fetchone()

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
    
    async def get_user_info(self,*,user_id: int):
        query = "SELECT * FROM users WHERE user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(user_id,))
            row = await cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404,detail="User not found")
            return row

    #WEBSOCKET RELATED
    async def insert_message(self,sender_id:int,time_sent,chat_id:str,message:str):
        message_id = uuid.uuid4()
        check_membership = "SELECT 1 FROM chat_users WHERE user_id = %s AND chat_id = %s"
        insert_message = "INSERT INTO messages(message_id,sent_by,time_sent,chat_id,content) VALUES(%s,%s,%s,%s,%s)"
        get_users = "SELECT user_id FROM chat_users WHERE chat_id = %s AND user_id != %s"
        insert_message_status = "INSERT INTO message_status(message_id,receiver_id) VALUES(%s,%s)"
        async with self._transaction() as cur:
            await cur.execute(check_membership,(sender_id,chat_id))
            membership = await cur.fetchall()
            if len(membership) <= 0:
                raise PermissionError("User not Part of Chat")
            await cur.execute(insert_message,(message_id,sender_id,time_sent,chat_id,message))
            await cur.execute(get_users,(chat_id,sender_id))
            user_ids = await cur.fetchall()
            data = [(message_id, row[0]) for row in user_ids]
            await cur.executemany(insert_message_status,data)
        return message_id

    async def insert_system_message(self,*,chat_id:str,actor_id:int,event:str,target_id:int) -> dict:
        """Record a membership/role event as a system message and return its frame.

        No message_status rows are written on purpose: an event should never drive an
        unread badge or be replayed by the pending-messages path, it just sits in the
        timeline (the same call WhatsApp makes). The names are read here rather than
        taken from the session, which only carries the username, not display_name.
        """
        if event not in SYSTEM_EVENTS:
            raise ValueError(f"unknown system event {event!r}")
        message_id = str(uuid.uuid4())
        time = datetime.now(timezone.utc)
        names = "SELECT user_id,display_name FROM users WHERE user_id IN (%s,%s)"
        insert = ("INSERT INTO messages(message_id,sent_by,time_sent,chat_id,content,kind,event,target_id) "
                  "VALUES(%s,%s,%s,%s,%s,'system',%s,%s)")
        async with self._transaction() as cur:
            await cur.execute(names,(actor_id,target_id))
            found = dict(await cur.fetchall())
            actor_name = found.get(actor_id) or "Someone"
            target_name = found.get(target_id) or "someone"
            text = system_text(event,actor_name,target_name)
            await cur.execute(insert,(message_id,actor_id,time.strftime("%Y-%m-%d %H:%M:%S.%f"),
                                      chat_id,text,event,target_id))
        return system_frame(message_id,chat_id,event,actor_id,found.get(actor_id),
                            target_id,found.get(target_id),text,time.isoformat())

    async def insert_chat(self,chat_id:str,chat_name:str,chat_users:list[int],is_dm:bool=False,dm_key:str|None=None,current_user_id:int|None=None):
        insert_chat = "INSERT INTO chats(chat_id,chat_name,is_dm,dm_key) VALUES(%s,%s,%s,%s)"
        insert_chat_users = "INSERT INTO chat_users(chat_id,user_id,role) VALUES(%s,%s,%s)"
        async with self._transaction() as cur:
            try:
                await cur.execute(insert_chat,(chat_id,chat_name,is_dm,dm_key))
            except aiomysql.IntegrityError:
                raise HTTPException(status_code=409,detail="chat already exists")
            for user_id in chat_users:
                role = "admin" if user_id == current_user_id else "user"
                await cur.execute(insert_chat_users,(chat_id,user_id,role))
            return True

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
            out = [i[0] for i in await cur.fetchall()]
        return out

    async def get_chats_info(self,user_id:int) -> dict:
        res = {}
        async with self._transaction() as cur:
            query_chatname_member = "SELECT a.chat_id, a.chat_name, a.is_dm, u.user_id, u.display_name, u.avatar_url, cu.role FROM chats AS a JOIN chat_users AS cu ON cu.chat_id = a.chat_id JOIN users AS u ON u.user_id = cu.user_id WHERE a.chat_id IN (SELECT chat_id FROM chat_users WHERE user_id = %s) ORDER BY a.chat_id"
            query_unread_count = "SELECT b.chat_id, COUNT(*) AS unread FROM message_status a JOIN messages b ON b.message_id = a.message_id WHERE a.receiver_id = %s AND a.status = 'NOT-DELIVERED' GROUP BY b.chat_id"
            # kind/event/target carried through so the sidebar can tell an event row from a
            # message on a cold boot, before any history is loaded.
            query_last_message = ("SELECT t.chat_id, t.message_id, t.sent_by, t.content, t.time_sent, "
                                  "t.kind, t.event, t.target_id, a.display_name, g.display_name "
                                  "FROM (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY time_sent DESC) rn "
                                  "FROM messages m WHERE m.chat_id IN (SELECT chat_id FROM chat_users WHERE user_id = %s)) t "
                                  "LEFT JOIN users a ON a.user_id = t.sent_by "
                                  "LEFT JOIN users g ON g.user_id = t.target_id "
                                  "WHERE t.rn = 1")
            await cur.execute(query_chatname_member,(user_id,))
            chatname_member = await cur.fetchall()
            await cur.execute(query_unread_count,(user_id,))
            unread_count = await cur.fetchall()
            await cur.execute(query_last_message,(user_id,))
            last_message = await cur.fetchall()
            for chat_id, chat_name, is_dm, user_id, display_name, avatar_url, role in chatname_member:
                exist = res.get(chat_id)
                if exist is None:
                    tmp = {"chat_id":chat_id,"chat_name":chat_name,"is_dm":bool(is_dm),"members":[{"user_id":user_id,"display_name":display_name,"avatar_url":avatar_url,"role":role}],"unread_message_count":0,"last_message":{}}
                    res[chat_id] = tmp
                    continue
                res[chat_id]["members"].append({"user_id":user_id,"display_name":display_name,"avatar_url":avatar_url,"role":role})
            for chat_id,unread_count in unread_count:
                res[chat_id]["unread_message_count"] = unread_count
            for chat_id,message_id,sent_by,content,time_sent,kind,event,target_id,actor_name,target_name in last_message:
                if kind == "system":
                    res[chat_id]["last_message"] = system_frame(message_id,chat_id,event,sent_by,actor_name,
                                                                target_id,target_name,content,iso_utc(time_sent))
                else:
                    res[chat_id]["last_message"] = {"message_id":message_id,"sender_id":sent_by,"message":content,"time_sent":iso_utc(time_sent)}
            return {"data":sorted(res.values(),key=lambda x:x["last_message"].get("time_sent") or "",reverse=True)}
    
    async def get_chat_message(self,chat_id: str, user_id:int, limit:int,offset:int) -> dict :
        query = ("SELECT m.message_id, m.sent_by, u.display_name, m.time_sent, m.chat_id, m.content, "
                 "m.kind, m.event, m.target_id, t.display_name "
                 "FROM messages AS m "
                 "JOIN users AS u ON u.user_id = m.sent_by "
                 "LEFT JOIN users AS t ON t.user_id = m.target_id "
                 "WHERE m.chat_id IN (SELECT b.chat_id FROM chat_users AS b WHERE b.user_id = %s) "
                 "AND m.chat_id = %s "
                 "ORDER BY m.time_sent DESC LIMIT %s OFFSET %s")
        async with self._transaction() as cur:
            await cur.execute(query,(user_id,chat_id,limit,offset))
            out = await cur.fetchall()
        messages = []
        for message_id,sender_id,sender_name,time_sent,cid,content,kind,event,target_id,target_name in out:
            if kind == "system":
                messages.append(system_frame(message_id,cid,event,sender_id,sender_name,
                                             target_id,target_name,content,iso_utc(time_sent)))
            else:
                messages.append({"type":"message","message_id":message_id,"sender_id":sender_id,
                                 "sender_name":sender_name,"message":content,
                                 "time_sent":iso_utc(time_sent),"chat_id":cid})
        has_more = len(messages) == limit          # a full page -> assume more exist
        messages.reverse()                         # DESC from SQL -> oldest->newest for display
        return {"data":messages,"has_more":has_more}

    async def get_chat_info(self,chat_id: str) -> dict:
        query = "SELECT * from chats WHERE chat_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(chat_id,))
            out = await cur.fetchone()
            if not out:
                raise HTTPException(status_code=404,detail="Chat not found")
            return {"chat_id":out[0],"chat_name":out[1],"is_dm":out[2],"dm_key":out[3]}
    
    async def insert_refresh_token(self,*,token_hash: str,user_id: int, expires_at: str, created_at: str) -> None:
        query = "INSERT INTO refresh_tokens(token_hash,user_id,expires_at,revoked,created_at) VALUES (%s,%s,%s,%s,%s)"
        async with self._transaction() as cur:
            await cur.execute(query,(token_hash,user_id,expires_at,False,created_at))

    async def revoke_refresh_token(self,user_id: int) -> None:
        query = "UPDATE refresh_tokens SET revoked = True ,expires_at = %s WHERE user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f"),user_id))

    async def refresh_refresh_token(self,*,user_id: int,old_token_hash: str, new_refresh_token: str,expires_at: str,created_at: str) -> None:
        update_query = "UPDATE refresh_tokens SET revoked = True, expires_at = NOW() where user_id = %s and token_hash = %s"
        insert_query = "INSERT INTO refresh_tokens(token_hash,user_id,expires_at,revoked,created_at) VALUES (%s,%s,%s,%s,%s)"
        async with self._transaction() as cur:
            await cur.execute(update_query,(user_id,old_token_hash))
            await cur.execute(insert_query,(new_refresh_token,user_id,expires_at,False,created_at))

    async def get_user_id_with_refresh(self,*,token_hash: str) -> int:
        async with self._transaction() as cur:
            await cur.execute("SELECT user_id FROM refresh_tokens WHERE token_hash=%s AND revoked=False AND expires_at >= NOW()",(token_hash,))
            out = await cur.fetchone()
            if not out:
                raise HTTPException(status_code=404,detail="A user with this refresh token is not found")
        return out[0]
    
    async def search_username(self,*,input: str,searcher_id: int,limit: int) -> dict:
        res = {"users":[]}
        query = "SELECT user_id, display_name, username, avatar_url FROM users WHERE (display_name LIKE %s OR username LIKE %s) AND user_id != %s ORDER BY display_name LIMIT %s"
        async with self._transaction() as cur:
            await cur.execute(query,(input+"%",input+"%",searcher_id,limit))
            out = await cur.fetchall()
            for user_id,display_name,username,avatar_url in out:
                res["users"].append({"user_id":user_id,"display_name":display_name,"username":username,"avatar_url":avatar_url})
        return res

    async def delete_chat(self,*,chat_id: str) -> bool:
        delete_message_status_query = "DELETE FROM message_status WHERE message_id IN (SELECT message_id FROM messages WHERE chat_id = %s)"
        delete_messages_query = "DELETE FROM messages WHERE chat_id = %s"
        delete_chat_users_query = "DELETE FROM chat_users WHERE chat_id = %s"
        delete_chat_query = "DELETE FROM chats WHERE chat_id = %s"
        async with self._transaction() as cur:
            try:
                await cur.execute(delete_message_status_query,(chat_id,))
                await cur.execute(delete_messages_query,(chat_id,))
                await cur.execute(delete_chat_users_query,(chat_id,))
                await cur.execute(delete_chat_query,(chat_id,))
            except Exception:
                raise HTTPException(status_code=500,detail="Failed to delete chat")
        return True

        

    async def check_user_role(self,*,chat_id:str, user_id: int) -> str:
        query = "SELECT role FROM chat_users WHERE chat_id = %s AND user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(chat_id,user_id))
            out = await cur.fetchone()
            if not out:
                raise HTTPException(status_code=404,detail="User not found in this chat")
            return out[0]

    async def get_user_role(self,*,chat_id:str, user_id: int) -> str|None:
        # Same query as check_user_role, but returns None for a non-member instead of
        # raising 404 -- for callers asking "is this person in the chat?".
        query = "SELECT role FROM chat_users WHERE chat_id = %s AND user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(query,(chat_id,user_id))
            out = await cur.fetchone()
            return out[0] if out else None

    async def change_role(self,*,chat_id: str,user_id: int,new_role: str) -> None:
        update_query = "UPDATE chat_users SET role = %s WHERE chat_id = %s AND user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(update_query,(new_role,chat_id,user_id))
            affected_rows = cur.rowcount
            if affected_rows == 0:
                raise HTTPException(status_code=404,detail="User not found in this chat")

    async def get_admin_count(self,*,chat_id: str) -> int:
        query = "SELECT COUNT(*) FROM chat_users WHERE chat_id = %s AND role = 'admin'"
        async with self._transaction() as cur:
            await cur.execute(query,(chat_id,))
            out = await cur.fetchone()
            return out[0] if out else 0

    async def leave_chat(self,*,chat_id: str,user_id: int) -> bool:
        delete_query = "DELETE FROM chat_users WHERE chat_id = %s AND user_id = %s"
        async with self._transaction() as cur:
            await cur.execute(delete_query,(chat_id,user_id))
            affected_rows = cur.rowcount
            if affected_rows == 0:
                raise HTTPException(status_code=404,detail="User not found in this chat")
        return True

    async def add_members(self,*,chat_id: str,user_ids: list[int]) -> None:
        insert_query = "INSERT INTO chat_users(chat_id,user_id,role) VALUES (%s,%s,%s)"
        async with self._transaction() as cur:
            for user_id in user_ids:
                try:
                    await cur.execute(insert_query,(chat_id,user_id,"user"))
                except aiomysql.IntegrityError:
                    raise HTTPException(status_code=409,detail=f"user {user_id} already exists in this chat")

connection = Database(user,password,database,host)
