# Chat App

A real-time web chat application with direct messages and group chats.

## Stack

- **Backend:** Python, FastAPI, WebSockets
- **Database:** MySQL, with versioned SQL migrations
- **Messaging:** Redis pub/sub for fan-out of messages across connections and workers
- **Frontend:** plain HTML, CSS and JavaScript (no build step), served by nginx
- **Auth:** JWT session cookie plus a rotating refresh token, passwords hashed with bcrypt
- **Infrastructure:** Docker Compose

nginx serves the frontend on port 8080 and proxies `/api/` to the FastAPI backend on port 8000.
Clients connect to the backend's `/ws` endpoint for real-time messaging.

## Setup

### Prerequisites

- Docker and Docker Compose
- Python 3 (only needed to generate a password hash or run the backend outside Docker)

### 1. Environment file

Copy the example and fill in the values:

```sh
cp app/.env.example app/.env
```

```
MYSQL_ROOT_PASSWORD=<root password for the MySQL container>
MYSQL_DATABASE=chatapp
DB_USER=<application database user>
DB_PASSWORD=<application database user's password>
DB_DATABASE=chatapp
JWT_SECRET_KEY=<secret key>
```

Generate the JWT secret with `openssl rand -base64 32`. This file is also passed to the MySQL
container, so the `MYSQL_*` variables are read from it.

### 2. Database init script

Copy the example:

```sh
cp database/init-db.sql.example database/init-db.sql
```

Edit it so the user and password match `DB_USER` and `DB_PASSWORD` in `app/.env`, and replace the
admin password with a bcrypt hash:

```sql
CREATE USER 'chatappuser'@'%' IDENTIFIED BY 'examplepassword';
GRANT ALL PRIVILEGES ON chatapp.* TO 'chatappuser'@'%';
FLUSH PRIVILEGES;
USE chatapp;
INSERT INTO users(username,password,role,display_name) VALUES('admin','<bcrypt hash>','admin','administrator');
```

A hash can be generated with (requires `pip install bcrypt`):

```sh
python3 -c "import bcrypt; print(bcrypt.hashpw(b'your-password', bcrypt.gensalt(12)).decode())"
```

This script runs only when the database volume is first created.

### 3. Start the stack

```sh
docker compose up
```

| Service  | Address                      |
|----------|------------------------------|
| Frontend | http://localhost:8080        |
| API docs | http://localhost:8000/docs   |
| MySQL    | localhost:3307               |
| Redis    | localhost:6379               |

Database migrations in `database/migrations/` are applied automatically when the backend container
starts. Backend dependencies are installed on every start as well, so changes to
`app/requirements.txt` only need a container restart.

### Running the backend outside Docker (optional)

With MySQL and Redis still running through Compose:

```sh
python3 -m venv venv
source venv/bin/activate
pip install -r app/requirements.txt
python database/migrate.py
cd app && uvicorn main:app --reload
```

The backend must be started from `app/` so that `app/.env` is picked up.

### Resetting the database

`./docker_rebuild.sh` removes the containers, images and volumes and starts the stack again. This
deletes all data. It is only required after changing `database/init-db.sql`; schema changes are
added as new numbered files in `database/migrations/` and do not need a reset.
