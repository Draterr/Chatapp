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
  id int AUTO_INCREMENT,
  sent_by int NOT NULL,
  time_sent DATETIME NOT NULL,
  chat_id char(36) NOT NULL,
  content TEXT(2048) NOT NULL,
  status ENUM('DELIVERED','NOT-DELIVERED') NOT NULL,
  PRIMARY KEY(id),
  FOREIGN KEY(sent_by) REFERENCES users(user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
);
