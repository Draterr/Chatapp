USE chatapp;
INSERT INTO chats (chat_id, chat_name) VALUES
('d1bcd22b-81fb-4094-8412-ff28a532c93a', 'test');
INSERT INTO chats (chat_id, chat_name) VALUES
('2b9293a2-d50b-445a-a82f-777523bdb741', 'lol');
INSERT INTO users (username, password, role, display_name) VALUES
('susan', '$2a$12$B/hbz8Tb7YI/4/Hw3h4omeyKXKg6EsuxaMjqAaGQJiWjkIgWWeZQ6', 'user', 'susan');
INSERT INTO users (username, password, role, display_name) VALUES
('dave', '$2a$12$B/hbz8Tb7YI/4/Hw3h4omeyKXKg6EsuxaMjqAaGQJiWjkIgWWeZQ6', 'user', 'dave');
INSERT INTO chat_users(chat_id, user_id) VALUES
('d1bcd22b-81fb-4094-8412-ff28a532c93a', 2);
INSERT INTO chat_users(chat_id, user_id) VALUES
('d1bcd22b-81fb-4094-8412-ff28a532c93a', 3);
INSERT INTO chat_users(chat_id, user_id) VALUES
('2b9293a2-d50b-445a-a82f-777523bdb741', 2);
INSERT INTO chat_users(chat_id, user_id) VALUES
('2b9293a2-d50b-445a-a82f-777523bdb741', 3);
