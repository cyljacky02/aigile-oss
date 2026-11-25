-- 再驗證身分：敏感的管理操作前，要在這台裝置上再輸入一次密碼，10 分鐘內有效
-- 記在這台裝置的登入上（epoch 毫秒，跟 devices 其他時間欄一樣）；空的＝還沒再驗證過
-- 只加不刪：舊版程式不讀這欄，照常能跑
ALTER TABLE devices ADD COLUMN reauth_at INTEGER;
