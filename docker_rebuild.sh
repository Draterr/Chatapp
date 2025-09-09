#!/bin/sh

docker container prune && docker image rm chatapp-backend chatapp-nginx chatapp-mysql_db && docker volume prune
docker compose up
