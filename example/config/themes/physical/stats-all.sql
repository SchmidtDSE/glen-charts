WITH b AS (
  SELECT CAST(ECO_CODE AS INTEGER) AS id, h8, side, depth_m, elevation_m
  FROM read_parquet('s3://public-coastal/meow-coastal-band/hex/h0=*/data_0.parquet')
  WHERE dist_km <= {{WIDTH}}
),
s AS (
  SELECT id,
         SUM(h3_cell_area(h8, 'km^2')) FILTER (WHERE side = 'sea') AS sea_area,
         SUM(h3_cell_area(h8, 'km^2')) FILTER (WHERE side = 'land') AS land_area,
         AVG(depth_m) FILTER (WHERE side = 'sea' AND depth_m >= 0) AS mean_depth,
         AVG(elevation_m) FILTER (WHERE side = 'land') AS mean_elev
  FROM b GROUP BY id
)
SELECT id, variable, label, value, fmt, scale, ord FROM s,
  (VALUES ('sea_area', 'Sea area (km²)', 'km2', 'log', 1), ('land_area', 'Land area (km²)', 'km2', 'log', 2),
          ('mean_depth', 'Mean depth (m)', 'num1', 'linear', 3), ('mean_elev', 'Mean land elevation (m)', 'num1', 'linear', 4)) v(variable, label, fmt, scale, ord),
  LATERAL (SELECT CASE variable WHEN 'sea_area' THEN s.sea_area WHEN 'land_area' THEN s.land_area WHEN 'mean_depth' THEN s.mean_depth ELSE s.mean_elev END AS value)
ORDER BY id, ord
