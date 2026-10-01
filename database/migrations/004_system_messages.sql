-- Membership/role events live in `messages` so they inherit ordering, pagination,
-- the sidebar's last_message and pubsub fan-out for free. `sent_by` is the actor,
-- `target_id` the person the event is about (same person for a self-initiated leave).
ALTER TABLE messages ADD kind ENUM('user','system') NOT NULL DEFAULT 'user';
ALTER TABLE messages ADD event VARCHAR(32) DEFAULT NULL;
ALTER TABLE messages ADD target_id INT DEFAULT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_target_fk FOREIGN KEY(target_id) REFERENCES users(user_id);
