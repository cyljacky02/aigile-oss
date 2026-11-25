-- 刪除訊息（docs/adr/0003）：被刪的訊息列保留，在對話裡顯示佔位；可復原期內可以復原，期滿永久清除
-- 時間都是 ISO 字串（跟 messages.created_at 一樣）；deleted_by＝刪除者 participantId；clear_id＝所屬的清空專案訊息操作（單獨刪除為空）
-- purged_at：永久清除的時間（內文與附件已清掉，佔位留著）
-- 只加不刪：舊版程式不讀這些欄，照常能跑（只是看得到被刪的訊息）
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN deleted_by TEXT;
ALTER TABLE messages ADD COLUMN purge_at TEXT;
ALTER TABLE messages ADD COLUMN clear_id TEXT;
ALTER TABLE messages ADD COLUMN purged_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_purge ON messages (purge_at);
CREATE INDEX IF NOT EXISTS idx_messages_clear ON messages (clear_id);
