CREATE TABLE report_users (
  id text PRIMARY KEY,
  public_number integer GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL
);

CREATE TABLE reports (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id text NOT NULL REFERENCES report_users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  category text NOT NULL CHECK (category IN ('Roads','Lighting','Sanitation','Parks','Traffic','Drainage','Vandalism','Other')),
  severity text NOT NULL CHECK (severity IN ('High','Medium','Low')),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  location text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_created_idx ON reports(created_at DESC, id DESC);

CREATE TABLE report_photos (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES report_users(id),
  report_id integer REFERENCES reports(id) ON DELETE CASCADE,
  staging_key text NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE,
  ready boolean NOT NULL DEFAULT false,
  position smallint CHECK (position BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  CHECK (report_id IS NULL OR (ready AND position IS NOT NULL)),
  UNIQUE (report_id, position)
);
CREATE INDEX report_photos_owner_idx ON report_photos(owner_id, created_at);
CREATE INDEX report_photos_orphan_idx ON report_photos(expires_at) WHERE report_id IS NULL;

CREATE TABLE report_comments (
  id uuid PRIMARY KEY,
  report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES report_users(id),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_comments_report_idx ON report_comments(report_id, created_at, id);

CREATE TABLE report_votes (
  report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES report_users(id),
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE report_reactions (
  report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES report_users(id),
  PRIMARY KEY (report_id, user_id)
);
