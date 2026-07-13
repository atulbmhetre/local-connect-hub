SELECT b.id AS bucket_id,
       b.name,
       b.public,
       COUNT(o.id)::bigint AS object_count,
       COALESCE(SUM((o.metadata->>'size')::bigint), 0)::bigint AS total_bytes
FROM storage.buckets b
LEFT JOIN storage.objects o ON o.bucket_id = b.id
GROUP BY b.id, b.name, b.public
ORDER BY b.name;
