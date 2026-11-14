-- Where to center each photo when it's cropped to fit a card (percent across and down).
-- Default 50 / 38: the middle, a bit above center, where a dog's or person's face usually is.
-- Nonprofit staff change it by clicking the face in the photo editor.

alter table public.follow_items
  add column photo_focus_x smallint not null default 50 check (photo_focus_x between 0 and 100),
  add column photo_focus_y smallint not null default 38 check (photo_focus_y between 0 and 100);
