-- A parent can withdraw a request still in progress; it then frees the family's one open request.
ALTER TABLE app_request DROP CONSTRAINT app_request_status_check;
ALTER TABLE app_request ADD CONSTRAINT app_request_status_check CHECK (status IN ('requested', 'planned', 'building', 'declined', 'shipped', 'withdrawn'));
