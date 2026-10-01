ALTER TABLE chat_users ADD role ENUM('admin','user') NOT NULL DEFAULT 'user';
