-- Bracket chips in RadarSearch replaced radar_city/highway_radius_km config keys.

DELETE FROM public.app_config
WHERE key IN ('radar_city_radius_km', 'radar_highway_radius_km');
