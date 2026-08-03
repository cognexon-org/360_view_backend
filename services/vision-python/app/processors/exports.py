from __future__ import annotations

import csv
import io
import json
import math
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from openpyxl import Workbook

from ..storage import put_bytes


def _rooms(model: dict[str, Any]) -> list[dict[str, Any]]:
    rooms = model.get("rooms")
    if not isinstance(rooms, list) or not rooms:
        raise ValueError("Canonical model contains no rooms")
    return [room for room in rooms if isinstance(room, dict)]


def _bounds(model: dict[str, Any]) -> tuple[float,float,float,float]:
    pts=[p for room in _rooms(model) for p in room.get("floorPolygon",[]) if isinstance(p,list) and len(p)>=2]
    if not pts: return (0,0,1,1)
    xs=[float(p[0]) for p in pts]; ys=[float(p[1]) for p in pts]
    return min(xs),min(ys),max(xs),max(ys)


def _svg(model: dict[str, Any]) -> bytes:
    minx,miny,maxx,maxy=_bounds(model); scale=110; pad=55
    width=max(400,int((maxx-minx)*scale+2*pad)); height=max(400,int((maxy-miny)*scale+2*pad))
    def xy(p): return pad+(float(p[0])-minx)*scale, height-pad-(float(p[1])-miny)*scale
    chunks=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">', '<rect width="100%" height="100%" fill="white"/>', '<style>text{font-family:Arial,sans-serif}.dim{fill:#475569;font-size:13px}.room{fill:#f7f3ea;stroke:#17233b;stroke-width:7}</style>']
    for room in _rooms(model):
        points=room.get("floorPolygon") or []; coords=' '.join(f'{xy(p)[0]:.1f},{xy(p)[1]:.1f}' for p in points)
        chunks.append(f'<polygon class="room" points="{coords}"/>')
        cx=sum(float(p[0]) for p in points)/len(points); cy=sum(float(p[1]) for p in points)/len(points)
        chunks.append(f'<text x="{xy([cx,cy])[0]:.1f}" y="{xy([cx,cy])[1]:.1f}" text-anchor="middle" font-size="18" fill="#17233b">{room.get("name","Room")}</text>')
        for wall in room.get("walls") or []:
            start,end=wall.get("start"),wall.get("end")
            if not (isinstance(start,list) and isinstance(end,list)): continue
            sx,sy=xy(start); ex,ey=xy(end); length=math.dist([float(start[0]),float(start[1])],[float(end[0]),float(end[1])])
            chunks.append(f'<text class="dim" x="{(sx+ex)/2:.1f}" y="{(sy+ey)/2-6:.1f}" text-anchor="middle">{length:.2f} m</text>')
    chunks.append('<text x="24" y="28" font-size="14" fill="#64748b">PropertyTour360 · Designer-confirmed dimensions required for procurement</text></svg>')
    return ''.join(chunks).encode()


def _dxf(model: dict[str, Any]) -> bytes:
    lines=['0','SECTION','2','ENTITIES']
    for room in _rooms(model):
        for wall in room.get('walls') or []:
            a,b=wall.get('start'),wall.get('end')
            if not (isinstance(a,list) and isinstance(b,list)): continue
            lines += ['0','LINE','8',str(room.get('name','ROOM')),'10',str(a[0]),'20',str(a[1]),'30','0','11',str(b[0]),'21',str(b[1]),'31','0']
    lines += ['0','ENDSEC','0','EOF']
    return ('\n'.join(lines)+'\n').encode()


def _schedule_rows(model: dict[str, Any], schedule: str) -> list[list[Any]]:
    if schedule in {'BOQ_CSV','BOQ_XLSX'}:
        verification=(model.get('metadata') or {}).get('verificationStatus','UNCONFIRMED')
        rows=[['room','item_type','item_id','description','sku','quantity','unit','unit_price','currency','subtotal','quantity_status']]
        for room in _rooms(model):
            polygon=room.get('floorPolygon') or []
            area=0.0
            if len(polygon)>=3:
                area=abs(sum(float(polygon[i][0])*float(polygon[(i+1)%len(polygon)][1])-float(polygon[(i+1)%len(polygon)][0])*float(polygon[i][1]) for i in range(len(polygon)))/2)
            floor_material=room.get('floorMaterial') or 'Floor finish'
            rows.append([room.get('name'),'FLOOR',room.get('id'),floor_material,None,round(area,3),'m2',None,None,None,verification])
            for wall in room.get('walls') or []:
                length=math.dist(wall.get('start',[0,0]),wall.get('end',[0,0])); wall_area=length*float(wall.get('heightM') or room.get('heightM') or 0)
                price=wall.get('costPerM2'); subtotal=round(wall_area*float(price),2) if price is not None else None
                rows.append([room.get('name'),'WALL_FINISH',wall.get('id'),wall.get('material'),wall.get('sku'),round(wall_area,3),'m2',price,wall.get('currency'),subtotal,verification])
            for obj in room.get('objects') or []:
                price=obj.get('price'); rows.append([room.get('name'),'PRODUCT',obj.get('id'),obj.get('name') or obj.get('type'),obj.get('sku'),1,'each',price,obj.get('currency'),price,verification])
        return rows
    if schedule == 'DOOR_WINDOW_SCHEDULE':
        rows=[['room','wall_id','opening_id','type','offset_m','width_m','height_m','sill_m','verification']]
        for room in _rooms(model):
            for wall in room.get('walls') or []:
                for opening in wall.get('openings') or []:
                    rows.append([room.get('name'),wall.get('id'),opening.get('id'),opening.get('type'),opening.get('offsetM'),opening.get('widthM'),opening.get('heightM'),opening.get('sillM',opening.get('bottomM',0)),opening.get('verificationStatus')])
        return rows
    if schedule == 'MATERIAL_SCHEDULE':
        rows=[['room','element_type','element_id','material','area_or_quantity','unit','supplier','sku']]
        for room in _rooms(model):
            for wall in room.get('walls') or []:
                length=math.dist(wall.get('start',[0,0]),wall.get('end',[0,0])); area=length*float(wall.get('heightM') or room.get('heightM') or 0)
                rows.append([room.get('name'),'WALL',wall.get('id'),wall.get('material'),round(area,3),'m2',wall.get('supplier'),wall.get('sku')])
            for obj in room.get('objects') or []:
                rows.append([room.get('name'),'OBJECT',obj.get('id'),obj.get('material'),1,'each',obj.get('supplier'),obj.get('sku')])
        return rows
    rows=[['room','object_id','name','type','catalogue_asset_id','sku','width_m','depth_m','height_m','material','quantity','unit_price','currency']]
    for room in _rooms(model):
        for obj in room.get('objects') or []:
            size=obj.get('size') or obj.get('dimensionsM') or [0,0,0]
            rows.append([room.get('name'),obj.get('id'),obj.get('name'),obj.get('type'),obj.get('catalogueAssetId'),obj.get('sku'),*(list(size)+[0,0,0])[:3],obj.get('material'),1,obj.get('price'),obj.get('currency')])
    return rows


def _csv_bytes(rows: list[list[Any]]) -> bytes:
    stream=io.StringIO(); writer=csv.writer(stream); writer.writerows(rows); return stream.getvalue().encode('utf-8-sig')


def _xlsx_bytes(rows: list[list[Any]]) -> bytes:
    wb=Workbook(); ws=wb.active; ws.title='Schedule'
    for row in rows: ws.append(row)
    ws.freeze_panes='A2'; ws.auto_filter.ref=ws.dimensions
    for col in ws.columns:
        letter=col[0].column_letter; ws.column_dimensions[letter].width=min(42,max(10,max(len(str(cell.value or '')) for cell in col)+2))
    stream=io.BytesIO(); wb.save(stream); return stream.getvalue()


def _raster(model: dict[str, Any], fmt: str) -> bytes:
    minx,miny,maxx,maxy=_bounds(model); scale=180; pad=90
    width=max(800,int((maxx-minx)*scale+2*pad)); height=max(800,int((maxy-miny)*scale+2*pad))
    image=Image.new('RGB',(width,height),'white'); draw=ImageDraw.Draw(image)
    def xy(p): return pad+(float(p[0])-minx)*scale, height-pad-(float(p[1])-miny)*scale
    for room in _rooms(model):
        points=[xy(p) for p in room.get('floorPolygon') or []]
        if len(points)>=3: draw.polygon(points,fill='#f3efe5',outline='#17233b',width=8)
        if points:
            cx=sum(p[0] for p in points)/len(points); cy=sum(p[1] for p in points)/len(points); draw.text((cx,cy),str(room.get('name','Room')),fill='#17233b',anchor='mm')
    draw.text((24,24),'PropertyTour360 · Draft/confirmed status must accompany this plan',fill='#64748b')
    stream=io.BytesIO()
    if fmt=='PDF': image.save(stream,'PDF',resolution=150.0)
    elif fmt=='JPEG': image.save(stream,'JPEG',quality=92)
    else: image.save(stream,'PNG')
    return stream.getvalue()


def export_artifact(payload: dict[str, Any]) -> dict[str, Any]:
    model=payload.get('model') if isinstance(payload.get('model'),dict) else {}
    fmt=str(payload.get('format') or 'CANONICAL_JSON').upper()
    output_bucket=str(payload['outputBucket']); output_key=str(payload['outputKey'])
    mime='application/octet-stream'
    if fmt=='CANONICAL_JSON': data=json.dumps(model,indent=2,separators=(',',': ')).encode(); mime='application/json'
    elif fmt=='SVG': data=_svg(model); mime='image/svg+xml'
    elif fmt=='DXF': data=_dxf(model); mime='application/dxf'
    elif fmt in {'CSV','BOQ_CSV','DOOR_WINDOW_SCHEDULE','MATERIAL_SCHEDULE'}: data=_csv_bytes(_schedule_rows(model,fmt)); mime='text/csv'
    elif fmt in {'XLSX','BOQ_XLSX'}: data=_xlsx_bytes(_schedule_rows(model,fmt)); mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    elif fmt in {'PNG','JPEG','PDF'}: data=_raster(model,fmt); mime={'PNG':'image/png','JPEG':'image/jpeg','PDF':'application/pdf'}[fmt]
    elif fmt=='MEASUREMENT_REPORT':
        rows=[['room','measurement_id','label','value_m','method','tolerance_m','verified','residual_m']]
        for room in _rooms(model):
            residual_by_id={r.get('measurementId'):r for r in room.get('measurementResiduals') or []}
            for m in room.get('measurements') or []:
                residual=residual_by_id.get(m.get('id'),{}); rows.append([room.get('name'),m.get('id'),m.get('label'),m.get('valueM'),m.get('method'),m.get('toleranceM'),m.get('verified'),residual.get('residualM')])
        data=_csv_bytes(rows); mime='text/csv'
    else: raise ValueError(f'Unsupported export format: {fmt}')
    put_bytes(output_bucket,output_key,data,mime)
    return {'outputBucket':output_bucket,'outputKey':output_key,'mimeType':mime,'sizeBytes':len(data),'format':fmt}
