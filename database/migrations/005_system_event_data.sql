-- Event-specific payload for a system row. Membership/role events are "actor acts on
-- target", which target_id covers; a rename has no target user at all, it has a name.
-- JSON rather than a scalar per event, so the next non-person event (pinned message,
-- avatar change, disappearing-messages timer) needs no further migration.
ALTER TABLE messages ADD event_data JSON DEFAULT NULL;
