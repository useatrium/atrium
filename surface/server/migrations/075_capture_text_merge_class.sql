-- Buffered node capture historically omitted merge_class, so text artifacts
-- were stamped with the immutable-data default and stale writes could not enter
-- diff3. Promote only node-created, text-only chains; mixed/binary chains and
-- explicitly classified non-node artifacts retain their existing policy.
UPDATE artifacts AS a
   SET merge_class = 'mergeable-doc'
 WHERE a.merge_class = 'immutable-data'
   AND EXISTS (
     SELECT 1
       FROM artifact_versions AS v
       JOIN cas_blobs AS b ON b.sha256 = v.blob_sha
      WHERE v.artifact_id = a.id
        AND v.seq = 1
        AND v.author LIKE 'node:%'
        AND b.is_text
   )
   AND NOT EXISTS (
     SELECT 1
       FROM artifact_versions AS v
       JOIN cas_blobs AS b ON b.sha256 = v.blob_sha
      WHERE v.artifact_id = a.id
        AND NOT b.is_text
   );
