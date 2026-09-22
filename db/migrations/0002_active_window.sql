-- Active chat window for group conversations.
--
-- After the bot replies in a group, the conversation is considered active
-- until `active_until` (milliseconds since epoch). `active_speaker_member_openid`
-- remembers who the bot was talking to, so that person's follow-up messages
-- can skip the autonomous decision path. Expiry is checked by timestamp, so
-- no cleanup job is required.

ALTER TABLE conversations ADD COLUMN active_until INTEGER;
ALTER TABLE conversations ADD COLUMN active_speaker_member_openid TEXT;
