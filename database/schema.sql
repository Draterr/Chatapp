CREATE DATABASE chatapp;

USE chatapp;
CREATE Table users (
  user_id int AUTO_INCREMENT,
  username varchar(255) NOT NULL UNIQUE,
  password varchar(72) NOT NULL,
  role ENUM('admin','user') NOT NULL,
  display_name varchar(255) NOT NULL UNIQUE,
  avatar_url varchar(2083),
  PRIMARY KEY(user_id)
);

CREATE Table chats (
  chat_id char(36),
  chat_name VARCHAR(255),
  PRIMARY KEY(chat_id)
);

CREATE TABLE chat_users(
  chat_id char(36),
  user_id int,
  PRIMARY KEY(chat_id,user_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
);

CREATE TABLE messages(
  message_id char(36) NOT NULL,
  sent_by int NOT NULL,
  time_sent DATETIME(6) NOT NULL,
  chat_id char(36) NOT NULL,
  content TEXT(2048) NOT NULL,
  PRIMARY KEY(message_id),
  FOREIGN KEY(sent_by) REFERENCES users(user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
);

CREATE TABLE message_status(
  message_id char(36) NOT NULL,
  receiver_id int NOT NULL,
  status ENUM('DELIVERED','NOT-DELIVERED') NOT NULL DEFAULT 'NOT-DELIVERED',
  PRIMARY KEY(message_id,receiver_id),
  FOREIGN KEY(receiver_id) REFERENCES users(user_id),
  FOREIGN KEY(message_id) REFERENCES messages(message_id)
);
