Feature: GLB Mesh Editor model
  The editor's mesh model welds, deletes, moves, adds, flips and cuts points and polygons, edits UVs
  independently of positions, and round-trips through a GLB without losing the material.

  Background:
    Given a strip of two quads, 2 by 1, facing +Z, with UVs equal to x over 2 and y

  @GLB-MESH-001
  Scenario: Welding points with close UVs merges them at their average position
    When I weld the points at x 1 on the bottom and at x 1 on the top allowing UVs 0.6 apart
    Then the mesh has 5 vertices
    And the welded vertex is at x 1 and y 0.5
    And every polygon still uses three different vertices

  @GLB-MESH-002
  Scenario: Welding points whose UVs are far apart asks first and changes nothing
    Given the UVs of the point at x 2 on the bottom are moved by 0.5 in u
    When I weld the points at x 1 on the bottom and at x 2 on the bottom
    Then the weld is refused with a UV warning
    And the mesh has 6 vertices
    When I repeat the weld forced
    Then the weld succeeds with a UV warning
    And the mesh has 5 vertices

  @GLB-MESH-003
  Scenario: Deleting a point deletes the polygons that use it
    When I delete the point at x 0 on the bottom
    Then the mesh has 2 polygons using the 4 vertices at x 1 and x 2

  @GLB-MESH-004
  Scenario: Moving a point on a UV seam moves both sides of the seam
    Given the point at x 1 on the bottom is split into two vertices with different UVs
    When I move the point at x 1 on the bottom by 0.25 in z
    Then both vertices of that point are at z 0.25

  @GLB-MESH-005
  Scenario: Flipping the diagonal of two polygons that share an edge
    When I flip the diagonal of the two polygons of the left quad
    Then the left quad is still made of two polygons facing +Z
    And the left quad now uses the other diagonal

  @GLB-MESH-006
  Scenario: Flipping refuses polygons that do not share exactly two points
    When I try to flip the diagonal of the left quad's first polygon and the right quad's first polygon
    Then the flip is refused

  @GLB-MESH-007
  Scenario: Cutting a polygon in half also cuts its neighbour so no crack opens
    When I cut the first polygon of the left quad in half
    Then the mesh has 6 polygons
    And no edge has a vertex in its middle that the neighbouring polygon does not share

  @GLB-MESH-008
  Scenario: Adding a polygon from three points makes it face the camera
    When I add a polygon from the points at x 0 bottom, x 2 bottom and x 1 top looking along +Z
    Then the new polygon faces -Z
    When I add a polygon from the same points looking along -Z
    Then the second request is refused because the polygon exists

  @GLB-MESH-009
  Scenario: Moving a UV point changes only that vertex's UV
    When I move the UV of vertex 4 by 0.1 in u and -0.2 in v
    Then vertex 4 has UV 0.6 and 0.8 and its position is unchanged
    And every other vertex has its original UV

  @GLB-MESH-010
  Scenario: Saving a GLB keeps the material and the edits
    Given the mesh is part of a GLB with a red base colour material
    When I weld the points at x 1 on the bottom and at x 1 on the top allowing UVs 0.6 apart and save the GLB
    And I load the saved GLB again
    Then the saved GLB has 5 vertices and the red material
    And the saved GLB has UVs and normals on every vertex

  @GLB-MESH-011
  Scenario Outline: Weld puts the points at the average, first or last position
    When I weld the points at x 1 on the bottom and at x 1 on the top with the <mode> position allowing UVs 0.6 apart
    Then the welded vertex is at x 1 and y <y>

    Examples:
      | mode    | y   |
      | average | 0.5 |
      | first   | 0   |
      | last    | 1   |

  @GLB-MESH-012
  Scenario: Hidden polygons are left out of the drawing and stay hidden through later edits
    When I hide the two polygons of the left quad
    Then the drawing list has empty triangles for polygons 0 and 1 only
    And the vertices at x 0 are hidden and the vertices at x 1 are not
    When I delete polygon 2
    Then polygons 0 and 1 are still hidden
    When I show all polygons
    Then polygons 0 and 1 are shown and selected for the user

  @GLB-MESH-013
  Scenario: Rotating UV points a quarter turn about their centre
    When I rotate the UV points of the strip 90 degrees about 0.5 and 0.5
    Then the UV result contains the point 1 and 1

  @GLB-MESH-014
  Scenario: Distorting UV points by stretching and shearing
    When I scale the UV points 2 in u and 1 in v about 0 and 0
    Then the UV result contains the point 1 and 1
    When I shear the UV points in u by 0.5 about v 0
    Then the UV result contains the point 1.5 and 1

  @GLB-MESH-015
  Scenario: A lasso selects the points inside its outline
    Given a lasso outline from 0 0 to 10 0 to 10 10 to 0 10
    Then the point 5 and 5 is inside the lasso
    And the point 12 and 5 is outside the lasso

  @GLB-MESH-016
  Scenario: Point snap picks the nearest other UV point within range
    Given the other UV points 0.5 0.5 and 0.9 0.9
    Then dragging a point to 0.52 and 0.49 with range 0.05 snaps to 0.5 and 0.5
    And dragging a point to 0.7 and 0.7 with range 0.05 does not snap

  @GLB-MESH-017
  Scenario: A skinned mesh can have points moved but not welded, and keeps its joints when saved
    Given the strip is the mesh of a skinned GLB with one joint
    When I open that GLB in the editor
    Then the part allows moving points but not changing the topology
    When I select the point at x 1 on the bottom and move it by 0.3 in z in the editor
    And I try to weld in the editor
    Then the editor refused the weld and the strip still has 6 vertices
    When I save the editor's GLB and load it again
    Then the saved point is at z 0.3 and the joints and weights are unchanged

  @GLB-MESH-018
  Scenario Outline: H-Align and V-Align put the selected UV points on one line
    When I align the UV points 0 0, 1 0.5 and 0.5 1 with <align>
    Then every UV point has <coordinate> equal to <value>

    Examples:
      | align   | coordinate | value |
      | H-Align | v          | 0.5   |
      | V-Align | u          | 0.5   |

  @GLB-MESH-019
  Scenario: Unwrapping a bent surface flattens it without stretching
    Given a quarter cylinder strip of radius 1 and height 1 made of 8 by 2 quads
    When I unwrap all its polygons from their 3D positions
    Then every edge keeps the same length ratio between UV and 3D within 3 percent
    And the unwrapped UVs fit inside the UV area the strip had

  @GLB-MESH-020
  Scenario: A projection is fitted into the old UV area keeping its proportions
    When I fit the points 0 0, 4 0 and 4 2 into the UV area 0.2 0.2 to 0.6 0.8
    Then the fitted points span 0.4 across and 0.2 up and are centred on 0.4 and 0.5

  @GLB-MESH-021
  Scenario: Invert selection selects everything that is not selected
    Given the strip is the mesh of a skinned GLB with one joint
    When I open that GLB in the editor
    And I select the point at x 1 on the bottom in the editor
    And I invert the selection in the editor
    Then 5 points are selected and the point at x 1 on the bottom is not one of them
    When I invert the selection in the editor
    Then 1 points are selected and the point at x 1 on the bottom is one of them

  @GLB-MESH-022
  Scenario: Undo and redo step through point and polygon selections
    Given the strip is the mesh of a skinned GLB with one joint
    When I open that GLB in the editor
    And I select the point at x 1 on the bottom in the editor
    And I add the point at x 2 on the bottom to the selection in the editor
    And I select polygon 0 in the editor
    Then the editor is in polygon mode with 1 polygons and 0 points selected
    When I undo in the editor
    Then the editor is in point mode with 0 polygons and 2 points selected
    When I undo in the editor
    Then the editor is in point mode with 0 polygons and 1 points selected
    When I undo in the editor
    Then the editor is in point mode with 0 polygons and 0 points selected
    When I redo in the editor
    And I redo in the editor
    And I redo in the editor
    Then the editor is in polygon mode with 1 polygons and 0 points selected
    When I move the selected polygon by 0.5 in z in the editor
    And I undo in the editor
    Then the editor is in polygon mode with 1 polygons and 0 points selected
    When I undo in the editor
    Then the editor is in point mode with 0 polygons and 2 points selected

  @GLB-MESH-023
  Scenario: Loading a texture changes only the chosen part and is saved with the GLB
    Given two strips in one GLB that share a material with no texture
    When I open that GLB in the editor
    And I choose part 1 in the editor
    And I load a one pixel PNG as the texture of that part
    And I save the editor's GLB and load it again
    Then part 1 has that PNG as its base colour texture
    And part 0 still has no base colour texture
