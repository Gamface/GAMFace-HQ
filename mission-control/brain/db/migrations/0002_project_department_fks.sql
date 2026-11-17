-- Graph entities and tracker rows: a row's project must belong to the row's
-- department (same guarantee agents and memories already have).
-- Fails, and changes nothing, if any existing row is already mismatched.
ALTER TABLE kg_entities DROP CONSTRAINT IF EXISTS kg_entities_project_id_fkey;
ALTER TABLE kg_entities
    ADD CONSTRAINT kg_entities_project_in_department
    FOREIGN KEY (project_id, department_id) REFERENCES projects (id, department_id)
    ON DELETE SET NULL (project_id);

ALTER TABLE tracker_rows DROP CONSTRAINT IF EXISTS tracker_rows_project_id_fkey;
ALTER TABLE tracker_rows
    ADD CONSTRAINT tracker_rows_project_in_department
    FOREIGN KEY (project_id, department_id) REFERENCES projects (id, department_id)
    ON DELETE SET NULL (project_id);
