-- Q-13 E2E seed: one 450-message thread owned by memberA (org A), loaded by
-- e2e-q13.sh after fixtures.sql. DISPOSABLE DATABASES ONLY.
--   message 0/1     old turn a4c1...0001: user + assistant ERROR (outside the latest 400)
--   messages 2..447 plain history, "Long thread message N"
--   message 448/449 latest turn a4c1...0002: user + assistant ERROR (retryable)
DELETE FROM public.chat_threads WHERE id = 'a4700000-0000-4000-8000-0000000000c1';
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
  ('a4700000-0000-4000-8000-0000000000c1', 'a4a00000-0000-4000-8000-00000000000a', 'a4222222-2222-4222-8222-222222222222', 'Long thread (Q-13 E2E)', 'tugpt-scout');
INSERT INTO public.chat_messages (thread_id, organization_id, role, content, status, turn_id, created_at)
SELECT 'a4700000-0000-4000-8000-0000000000c1', 'a4a00000-0000-4000-8000-00000000000a',
       CASE WHEN i % 2 = 0 THEN 'user' ELSE 'assistant' END,
       CASE i WHEN 0 THEN 'Long thread opening question' WHEN 448 THEN 'Long thread latest question' ELSE 'Long thread message ' || i END,
       CASE WHEN i IN (1, 449) THEN 'error' ELSE 'complete' END,
       CASE WHEN i IN (0, 1) THEN 'a4c10000-0000-4000-8000-000000000001'::uuid WHEN i IN (448, 449) THEN 'a4c10000-0000-4000-8000-000000000002'::uuid END,
       now() - interval '1 day' + i * interval '1 second'
FROM generate_series(0, 449) AS i;
