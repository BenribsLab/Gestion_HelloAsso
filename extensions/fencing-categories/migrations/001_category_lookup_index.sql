-- Première migration appartenant au module. Les tables fencing_categories,
-- fencing_category_seasons et fencing_category_settings viennent encore des migrations
-- historiques du noyau (010, 011) : elles seront rapatriées ici plus tard, une fois qu'on
-- saura le faire sans risque de double application sur une base existante.

CREATE INDEX IF NOT EXISTS fencing_categories_season_lookup_idx
  ON fencing_categories (season_start_year, sort_order);
