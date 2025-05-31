FROM python:3.10
WORKDIR /app
COPY entrypoint.sh /dev_entrypoint.sh
RUN chmod +x /dev_entrypoint.sh
ENTRYPOINT ["/dev_entrypoint.sh"]
