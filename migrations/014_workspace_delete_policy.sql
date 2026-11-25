-- 工作區政策「誰可以刪除自己的訊息」（docs/adr/0003）：members＝所有成員（預設，新站與升級的站都一樣）、admins＝只有工作區管理員
-- 只加不刪：舊版程式不讀這一欄，照常能跑
ALTER TABLE workspaces ADD COLUMN delete_own_messages TEXT NOT NULL DEFAULT 'members';
