WITH b AS (
  SELECT b.* FROM read_parquet('s3://public-coastal/meow-coastal-band/hex/h0=*/data_0.parquet') b
  SEMI JOIN ({{AOI}}) a USING (h0, h8)
)
SELECT * FROM (VALUES
  ('sea_area', 'Sea area (km²)', (SELECT SUM(h3_cell_area(h8, 'km^2')) FROM b WHERE side = 'sea'), 'km2', 'log', 1),
  ('land_area', 'Land area (km²)', (SELECT SUM(h3_cell_area(h8, 'km^2')) FROM b WHERE side = 'land'), 'km2', 'log', 2),
  ('mean_depth', 'Mean depth (m)', (SELECT AVG(depth_m) FROM b WHERE side = 'sea' AND depth_m >= 0), 'num1', 'linear', 3),
  ('mean_elev', 'Mean land elevation (m)', (SELECT AVG(elevation_m) FROM b WHERE side = 'land'), 'num1', 'linear', 4)
) t(variable, label, value, fmt, scale, ord)
ORDER BY ord
