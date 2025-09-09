# Chat App
## Setup
1. ### Setup init-db.sql
- Create MYSQL user and ADMIN user in ./database/init-db.sql
```
CREATE USER 'chatappuser'@'%' IDENTIFIED BY 'examplepassword';
GRANT ALL PRIVILEGES ON chatapp.* TO 'chatappuser'@'%';
FLUSH PRIVILEGES;
USE chatapp;
INSERT INTO users(username,password,role,display_name) VALUES('admin','admin bcrypt hash','admin','administrator');
```
2. ### .env
```
DB_USER=[username of db_user] //user of a new user
DB_PASSWORD=[password of db_user] //password of the new user 
DB_DATABASE=chatapp
JWT_SECRET_KEY=[secret key] //generate with openssl rand -base64 32
```
3. ### Python Virtual Environment
```
python3 -m venv venv
source venv/bin/activate
```
4. ### Run Docker
 ```
 docker compose up
 ```

## App Structure
```
.
├── README.md
├── app
│   ├── Dockerfile
│   ├── __init__.py
│   ├── __pycache__
│   ├── db.py
│   ├── dependencies.py
│   ├── dev_entrypoint.sh
│   ├── entrypoint.sh
│   ├── main.py
│   ├── prod_entrypoint.sh
│   ├── pubsub.py
│   ├── requirements.txt
│   └── routers
│       ├── __init__.py
│       ├── __pycache__
│       ├── chats.py
│       ├── users.py
│       └── websocket.py
├── database
│   ├── Dockerfile
│   ├── Dockerfile.prod
│   ├── init-db.sql.example
│   ├── schema.sql
│   └── testdata.sql
├── docker-compose.yml
├── docker_rebuild.sh
├── nginx 
│   ├── Dockerfile
│   └── nginx.conf
├── pyrightconfig.json
├── static (frontend code)
│   └── index.html
```
