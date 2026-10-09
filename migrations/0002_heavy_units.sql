-- Merge both workspaces without losing records or memberships.
INSERT INTO units(id,name,short_name,code,color,description,stage,goal,budget,lead_id,version)
SELECT 'heavy','重装机器人','重装','01','#eac094',group_concat(description,char(10)),
 group_concat(DISTINCT stage),group_concat(goal,char(10)),sum(budget),
 COALESCE((SELECT lead_id FROM units WHERE id='hero'),(SELECT lead_id FROM units WHERE id='engineer')),max(version)+1
FROM units WHERE id IN ('hero','engineer');

UPDATE tasks SET unit_id='heavy',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id IN ('hero','engineer');
UPDATE milestones SET unit_id='heavy',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id IN ('hero','engineer');
UPDATE risks SET unit_id='heavy',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id IN ('hero','engineer');
UPDATE purchases SET unit_id='heavy',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id IN ('hero','engineer');

UPDATE users
SET unit_ids=(SELECT json_group_array(unit_id) FROM (
 SELECT DISTINCT CASE WHEN value IN ('hero','engineer') THEN 'heavy' ELSE value END AS unit_id
 FROM json_each(users.unit_ids)
)),version=version+1,updated_at=CURRENT_TIMESTAMP
WHERE EXISTS(SELECT 1 FROM json_each(users.unit_ids) WHERE value IN ('hero','engineer'));

-- Retain membership for both former leads. The main lead prefers hero.
UPDATE users SET unit_ids=json_insert(unit_ids,'$[#]','heavy'),version=version+1,updated_at=CURRENT_TIMESTAMP
WHERE id IN (SELECT lead_id FROM units WHERE id IN ('hero','engineer'))
 AND NOT EXISTS(SELECT 1 FROM json_each(users.unit_ids) WHERE value='heavy');
DELETE FROM units WHERE id IN ('hero','engineer');
