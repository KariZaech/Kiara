# Trailwise

Trailwise is a small browser app for designing a bike-trail network and finding a low-time route that covers every required trail.

## Run it

From this directory, start a local static server:

```sh
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). The supplied `graphdata.json` is loaded as the starter network. Its existing map layout sets outbound times proportionally to line length, calibrated by any relationship weights; inbound times initialize from the weight when present, or 10 minutes otherwise. Edit the values to match your rides.

## Use it

- Add trails by entering their start and end point names. A new point is created automatically when its name is new.
- Every point has a unique three-character alphanumeric code and a full name. The map shows the code and displays the full name on hover; edit both in the Trail points table.
- Set independent ride times for each direction. Mark access roads as optional to make them available as connectors without requiring them to be covered.
- Drag map points to reshape the network. Outbound time is tied to line length (scaled to fit the map), so moving a point updates the outbound times of its connected trails; inbound times remain independent. You can also edit an outbound time in the trail table to resize its line.
- Edit or remove trails in the table, and save named network versions in this browser.
- Import either this app’s exported JSON or a graph with `nodes` and `relationships` in the supplied graph-data format. Export the current network to JSON at any time.
- Select **Find fastest route** to see a route, total time, and ordered ride segments. All routes may begin and finish at any point.

The route finder computes a global optimum for up to 14 required trails. For larger required networks it returns a fast, valid route found by a multi-start greedy heuristic; this is clearly labeled in the result and is not guaranteed to be globally optimal. Every ride segment uses the direction-specific time, and trails may be repeated.

Saved versions and the current draft are stored in browser local storage. They are local to the browser and device.

## Check the route solver

```sh
node --test tests/solver.test.cjs
```