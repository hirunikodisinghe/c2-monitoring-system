SELECT
        ORDER_NO,
        SERIAL_NO,
        SHIFT_TIME_ID,
        EMP_NO1,
        BARCODE_ID,
        PART_NO,
        PART_DESCRIPTION,
        TO_CHAR(CREATED_DATE, 'YYYY-MM-DD HH24:MI:SS') CREATED_DATE,
        CREATED_BY,
        PRESS_NO,
        GRADE,
        ifsapp.C_Defect_API.Get_Description(site, defect1) DEFECT1_DESC,
        ifsapp.C_Defect_API.Get_Description(site, defect2) DEFECT2_DESC,
        ifsapp.C_Defect_API.Get_Description(site, defect3) DEFECT3_DESC,
        ifsapp.C_Defect_API.Get_Description(site, defect4) DEFECT4_DESC
FROM ifsapp.c_tire_manuf_proc_ovw
WHERE created_date >= TRUNC(SYSDATE) - :lookback
  AND GRADE = 'C2'
ORDER BY created_date ASC
