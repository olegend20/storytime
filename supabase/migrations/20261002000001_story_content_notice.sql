-- Issue #27: a parent may ask for a character from a film, game or book. The story is
-- written, and the reader says it borrows a character that belongs to someone else. The
-- notice has to survive a reload, so it is stored with the story. Null for every other story.
alter table stories add column content_notice text
  check (content_notice is null or content_notice in ('borrowed_character'));
