<?php
$select = ' SELECT id_MR
            FROM   rp_facilitiesForBilan
            WHERE  id_client = '.$id_client.'
            GROUP BY id_MR ORDER BY id_MR';
$message = 'COUNT Clients recus';
