<?php
function query($sql)
{
    global $db;
    return mysqli_query($db, $sql);
}

function escape($value)
{
    global $db;
    return mysqli_real_escape_string($db, $value);
}
