/**
 * WGS84 lat/lon primitive.
 *
 * Lives at the package root because `MeasuredPolyline` and
 * `PolylineProjection` (defined in other files) reference it. Re-exported
 * from `@n3ary/neary-gtfs-spec/shape` for consumers.
 */

/** Latitude / longitude pair, in degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}