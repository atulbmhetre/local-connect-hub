CREATE OR REPLACE FUNCTION increment_flag_count(p_post_id uuid, p_user_phone text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO feed_flags (post_id, flagged_by_phone)
  VALUES (p_post_id, p_user_phone);

  UPDATE feed_posts
  SET flagged_count = flagged_count + 1
  WHERE id = p_post_id;

  UPDATE feed_posts
  SET is_hidden = true
  WHERE id = p_post_id
    AND flagged_count >= 5;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_flag_count(uuid, text) TO anon;
