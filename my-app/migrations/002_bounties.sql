CREATE TABLE bounty_people (
  id text PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  name text NOT NULL,
  is_city boolean NOT NULL DEFAULT false,
  CHECK (is_city = (id = 'city'))
);

-- These balances and ledger entries are simulated credits, not real payments.
CREATE TABLE bounty_wallets (
  user_id text PRIMARY KEY REFERENCES bounty_people(id),
  balance_cents bigint NOT NULL CHECK (balance_cents BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE bounties (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  details text NOT NULL CHECK (char_length(details) <= 2000),
  reward_cents integer NOT NULL CHECK (reward_cents BETWEEN 1 AND 100000),
  poster_id text NOT NULL REFERENCES bounty_people(id),
  claimer_id text REFERENCES bounty_people(id),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  place text NOT NULL CHECK (char_length(place) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'done', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK ((status = 'open') = (claimer_id IS NULL)),
  CHECK (claimer_id IS NULL OR claimer_id <> poster_id)
);
CREATE INDEX bounties_created_idx ON bounties(created_at DESC, id DESC);
CREATE INDEX bounties_poster_idx ON bounties(poster_id);
CREATE INDEX bounties_claimer_idx ON bounties(claimer_id);

CREATE TABLE bounty_wallet_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES bounty_wallets(user_id),
  bounty_id integer REFERENCES bounties(id),
  kind text NOT NULL CHECK (kind IN ('opening', 'hold', 'payout')),
  amount_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'opening') = (bounty_id IS NULL)),
  CHECK ((kind = 'hold' AND amount_cents < 0) OR (kind <> 'hold' AND amount_cents > 0)),
  UNIQUE (user_id, bounty_id, kind)
);
CREATE UNIQUE INDEX bounty_wallet_opening_idx ON bounty_wallet_entries(user_id) WHERE kind = 'opening';

CREATE TABLE bounty_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bounty_id integer NOT NULL REFERENCES bounties(id),
  actor_id text NOT NULL REFERENCES bounty_people(id),
  action text NOT NULL CHECK (action IN ('post', 'claim', 'done', 'approve')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bounty_id, action)
);

CREATE TABLE bounty_photos (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES report_users(id),
  bounty_id integer UNIQUE REFERENCES bounties(id),
  staging_key text NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE,
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  CHECK (bounty_id IS NULL OR ready)
);
CREATE INDEX bounty_photos_owner_idx ON bounty_photos(owner_id, created_at);
CREATE INDEX bounty_photos_orphan_idx ON bounty_photos(expires_at) WHERE bounty_id IS NULL;
