-- A request the ET Ducky team marks Resolved or Closed without shipping an app through the publish tool is finished:
-- it stops being the family's open request and loses its Withdraw button.
ALTER TABLE app_request DROP CONSTRAINT app_request_status_check;
ALTER TABLE app_request ADD CONSTRAINT app_request_status_check CHECK (status IN ('requested', 'planned', 'building', 'declined', 'shipped', 'withdrawn', 'done'));
