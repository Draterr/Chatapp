FROM mysql:9.3.0
COPY schema.sql /docker-entrypoint-initdb.d/aschema.sql
COPY init-db.sql /docker-entrypoint-initdb.d/init-db.sql
