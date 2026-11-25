WITH b AS (
  SELECT b.* FROM read_parquet('s3://public-coastal/meow-coastal-band/hex/h0=*/data_0.parquet') b
  SEMI JOIN ({{AOI}}) a USING (h0, h8)
  WHERE b.dist_km <= {{WIDTH}}   -- a drawn area takes the band at this width too
)
-- comparable: whether a drawn area's value compares with whole ecoregions' (areas do not)
SELECT * FROM (VALUES
  ('sea_area', 'Sea area (km²)', (SELECT SUM(h3_cell_area(h8, 'km^2')) FROM b WHERE side = 'sea'), 'km2', 'log', 1, false),
  ('land_area', 'Land area (km²)', (SELECT SUM(h3_cell_area(h8, 'km^2')) FROM b WHERE side = 'land'), 'km2', 'log', 2, false),
  ('mean_depth', 'Mean depth (m)', (SELECT AVG(depth_m) FROM b WHERE side = 'sea' AND depth_m >= 0), 'num1', 'linear', 3, true),
  ('mean_elev', 'Mean land elevation (m)', (SELECT AVG(elevation_m) FROM b WHERE side = 'land'), 'num1', 'linear', 4, true)
) t(variable, label, value, fmt, scale, ord, comparable)
ORDER BY ord
